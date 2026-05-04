'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { QRCodeCanvas } from 'qrcode.react'

const BASE_URL = 'https://a1-parking.vercel.app'

export default function CompanyAdminPortal() {
  const [user, setUser] = useState<any>(null)
  const [role, setRole] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const [properties, setProperties] = useState<any[]>([])
  const [selectedProperty, setSelectedProperty] = useState<any>(null)
  const [stats, setStats] = useState({ total_vehicles: 0, violations_today: 0, violations_week: 0, active_passes: 0 })
  const [activeTab, setActiveTab] = useState('overview')

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

  const [storageFacilities, setStorageFacilities] = useState<any[]>([])
  const [ticketTarget, setTicketTarget] = useState<any>(null)
  const [selectedStorage, setSelectedStorage] = useState('')
  const [towFee, setTowFee] = useState('')
  const [mileage, setMileage] = useState('')
  const [vin, setVin] = useState('')
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null)

  const [violations, setViolations] = useState<any[]>([])
  const [violationFilter, setViolationFilter] = useState('today')
  const [violationSearch, setViolationSearch] = useState('')
  const [passes, setPasses] = useState<any[]>([])

  // Manage tab
  const [manageSection, setManageSection] = useState<'properties' | 'users' | 'drivers' | 'storage' | 'auditlog'>('properties')
  const [manageLoaded, setManageLoaded] = useState(false)

  const [editingProperty, setEditingProperty] = useState<any>(null)
  const [showAddProperty, setShowAddProperty] = useState(false)
  const [newProperty, setNewProperty] = useState({ name: '', address: '', city: '', state: '', zip: '', total_spaces: '', pm_name: '', pm_phone: '', pm_email: '' })
  const [propMsg, setPropMsg] = useState('')

  const [companyUsers, setCompanyUsers] = useState<any[]>([])
  const [resetPwTarget, setResetPwTarget] = useState<string | null>(null)
  const [resetPwForm, setResetPwForm] = useState({ newPw: '', confirmPw: '' })
  const [resetPwMsg, setResetPwMsg] = useState('')
  const [showAddUser, setShowAddUser] = useState(false)
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'manager', property: '' })
  const [userMsg, setUserMsg] = useState('')
  const [togglingUser, setTogglingUser] = useState<string | null>(null)

  const [companyDrivers, setCompanyDrivers] = useState<any[]>([])
  const [showAddDriver, setShowAddDriver] = useState(false)
  const [editingDriver, setEditingDriver] = useState<any>(null)
  const [newDriver, setNewDriver] = useState({ name: '', email: '', phone: '', operator_license: '', assigned_properties: [] as string[] })
  const [driverMsg, setDriverMsg] = useState('')

  const [allFacilities, setAllFacilities] = useState<any[]>([])
  const [showAddFacility, setShowAddFacility] = useState(false)
  const [newFacility, setNewFacility] = useState({ name: '', address: '', phone: '', email: '' })
  const [facilityMsg, setFacilityMsg] = useState('')
  const [companyAuditLogs, setCompanyAuditLogs] = useState<any[]>([])
  const [auditDateFilter, setAuditDateFilter] = useState('week')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)
  const [showActiveProps, setShowActiveProps] = useState(true)
  const [showActiveCompanyUsers, setShowActiveCompanyUsers] = useState(true)
  const [showActiveCompanyDrivers, setShowActiveCompanyDrivers] = useState(true)

  useEffect(() => { loadUser() }, [])

  useEffect(() => {
    if (showCamera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [showCamera])

  async function loadUser() {
    setLoading(true)
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase
      .from('user_roles').select('*').ilike('email', authUser.email!).single()

    if (!roleData || (roleData.role !== 'company_admin' && roleData.role !== 'admin')) {
      window.location.href = '/login'; return
    }

    setUser(authUser)
    setRole(roleData)

    let props: any[] = []
    if (roleData.role === 'admin') {
      const { data } = await supabase.from('properties').select('*').order('name')
      props = data || []
    } else {
      const { data } = await supabase.from('properties').select('*').ilike('company', roleData.company).order('name')
      props = data || []
    }

    setProperties(props)
    if (props.length > 0) {
      setSelectedProperty(props[0])
      await fetchAll(props[0])
    }
    setLoading(false)
    fetchStorageFacilities()
  }

  async function switchProperty(name: string) {
    const prop = properties.find(p => p.name === name)
    if (!prop) return
    setSelectedProperty(prop)
    setResult(null); setTicketTarget(null); setExpandedTicketId(null)
    await fetchAll(prop)
  }

  async function fetchAll(prop: any) {
    await Promise.all([fetchViolations(prop.name), fetchStats(prop.name), fetchPasses(prop.name)])
  }

  async function fetchStats(property: string) {
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const week = new Date(); week.setDate(week.getDate() - 7)
    const [{ data: vehicles }, { data: viol }] = await Promise.all([
      supabase.from('vehicles').select('id').ilike('property', property).eq('is_active', true),
      supabase.from('violations').select('created_at').ilike('property', property).gte('created_at', sixmo.toISOString()),
    ])
    const todayCount = (viol || []).filter(v => new Date(v.created_at) >= today).length
    const weekCount = (viol || []).filter(v => new Date(v.created_at) >= week).length
    setStats(s => ({ ...s, total_vehicles: vehicles?.length || 0, violations_today: todayCount, violations_week: weekCount }))
  }

  async function fetchStorageFacilities() {
    const { data } = await supabase.from('storage_facilities').select('*').eq('is_active', true).order('name')
    setStorageFacilities(data || [])
  }

  async function fetchViolations(property: string) {
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    const { data } = await supabase.from('violations').select('*')
      .ilike('property', property).gte('created_at', sixmo.toISOString())
      .order('created_at', { ascending: false })
    setViolations(data || [])
  }

  async function fetchPasses(property: string) {
    const now = new Date().toISOString()
    const { data: propResidents } = await supabase.from('residents').select('unit').ilike('property', property)
    const units = [...new Set((propResidents || []).map((r: any) => r.unit).filter(Boolean))]
    if (units.length === 0) { setPasses([]); setStats(s => ({ ...s, active_passes: 0 })); return }
    const { data } = await supabase.from('visitor_passes').select('*')
      .gte('expires_at', now).eq('is_active', true).in('visiting_unit', units)
      .order('created_at', { ascending: false })
    setPasses(data || [])
    setStats(s => ({ ...s, active_passes: data?.length || 0 }))
  }

  async function auditLog(action: string, table_name: string, record_id: string, new_values: any) {
    await supabase.from('audit_logs').insert([{
      user_email: user?.email, action, table_name,
      record_id: String(record_id), new_values,
      created_at: new Date().toISOString()
    }])
  }

  async function fetchCompanyAuditLogs() {
    setAuditLoaded(false)
    const userEmails = companyUsers.map(u => (u.email || '').toLowerCase())
    const companyName = (role?.company || '').toLowerCase()
    const { data } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    const filtered = (data || []).filter(log =>
      userEmails.includes((log.user_email || '').toLowerCase()) ||
      JSON.stringify(log.new_values || {}).toLowerCase().includes(companyName)
    )
    setCompanyAuditLogs(filtered)
    setAuditLoaded(true)
  }

  async function loadManageData() {
    await Promise.all([fetchCompanyUsers(), fetchCompanyDrivers(), fetchAllFacilitiesManage()])
    setManageLoaded(true)
  }

  async function fetchCompanyUsers() {
    if (!role?.company) return
    const { data } = await supabase.from('user_roles').select('*').ilike('company', role.company).neq('role', 'admin').order('email')
    setCompanyUsers(data || [])
  }

  async function fetchCompanyDrivers() {
    if (!role?.company) return
    const { data } = await supabase.from('drivers').select('*').ilike('company', role.company).order('name')
    setCompanyDrivers(data || [])
  }

  async function fetchAllFacilitiesManage() {
    const { data } = await supabase.from('storage_facilities').select('*').eq('is_active', true).order('name')
    setAllFacilities(data || [])
  }

  async function reloadProperties() {
    const { data } = await supabase.from('properties').select('*').ilike('company', role?.company || '').order('name')
    setProperties(data || [])
  }

  async function saveProperty() {
    if (!newProperty.name) { setPropMsg('Property name is required'); return }
    setPropMsg('')
    const { data, error: insErr } = await supabase.from('properties').insert([{
      name: newProperty.name, address: newProperty.address || null,
      city: newProperty.city || null, state: newProperty.state || null,
      zip: newProperty.zip || null,
      total_spaces: newProperty.total_spaces ? parseInt(newProperty.total_spaces) : null,
      pm_name: newProperty.pm_name || null, pm_phone: newProperty.pm_phone || null,
      pm_email: newProperty.pm_email || null, company: role?.company, is_active: true
    }]).select().single()
    if (insErr) { setPropMsg('Error: ' + insErr.message); return }
    await auditLog('create_property', 'properties', data.id, { name: newProperty.name, company: role?.company })
    setPropMsg('Property added!')
    setNewProperty({ name: '', address: '', city: '', state: '', zip: '', total_spaces: '', pm_name: '', pm_phone: '', pm_email: '' })
    setShowAddProperty(false)
    await reloadProperties()
  }

  async function updateProperty() {
    if (!editingProperty) return
    setPropMsg('')
    const { id, company, created_at, ...fields } = editingProperty
    const { error: updErr } = await supabase.from('properties').update({
      ...fields, total_spaces: fields.total_spaces ? parseInt(fields.total_spaces) : null
    }).eq('id', id)
    if (updErr) { setPropMsg('Error: ' + updErr.message); return }
    await auditLog('update_property', 'properties', id, fields)
    setPropMsg('Property updated!')
    setEditingProperty(null)
    await reloadProperties()
  }

  async function togglePropertyActive(prop: any) {
    const { error: updErr } = await supabase.from('properties').update({ is_active: !prop.is_active }).eq('id', prop.id)
    if (updErr) { setPropMsg('Error: ' + updErr.message); return }
    await auditLog(prop.is_active ? 'deactivate_property' : 'activate_property', 'properties', prop.id, { is_active: !prop.is_active })
    await reloadProperties()
  }

  async function createUser() {
    if (!newUser.email || !newUser.password || !newUser.role) { setUserMsg('Email, password, and role are required'); return }
    setUserMsg('Creating...')
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    const { data: { session } } = await supabase.auth.getSession()
    try {
      const res = await fetch(fnBase + '/swift-handler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'create_user', email: newUser.email, password: newUser.password })
      })
      const json = await res.json()
      if (!res.ok) { setUserMsg('Error: ' + (json.error || 'Failed to create auth account')); return }
    } catch (e: any) { setUserMsg('Error: ' + e.message); return }
    const propertyArray = newUser.property
      ? newUser.property.split('|').map(p => p.trim()).filter(Boolean)
      : []
    const { error: insErr } = await supabase
      .rpc('insert_user_role', {
        p_email: newUser.email.trim(),
        p_role: newUser.role,
        p_company: role?.company || '',
        p_property: propertyArray.length > 0 ? propertyArray : []
      })
    if (insErr) { setUserMsg('Auth created but role insert failed: ' + insErr.message); return }
    if (newUser.role === 'resident') {
      await supabase.from('residents').insert([{
        email: newUser.email.trim(),
        name: newUser.email.trim(),
        property: propertyArray[0] || null,
        company: role?.company || null,
        unit: '',
        is_active: true
      }])
    }
    if (newUser.role === 'driver') {
      await supabase.from('drivers').insert([{
        email: newUser.email.trim(),
        name: newUser.email.trim(),
        company: role?.company || null,
        assigned_properties: propertyArray,
        is_active: true
      }])
    }
    await auditLog('create_user', 'user_roles', newUser.email, { email: newUser.email, role: newUser.role, company: role?.company })
    setUserMsg('User created successfully!')
    setNewUser({ email: '', password: '', role: 'manager', property: '' })
    setShowAddUser(false)
    fetchCompanyUsers()
  }

  async function createDriver() {
    if (!newDriver.name || !newDriver.email) { setDriverMsg('Name and email are required'); return }
    setDriverMsg('Creating...')
    const tempPass = Math.random().toString(36).slice(-8) + 'A1!'
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    const { data: { session } } = await supabase.auth.getSession()
    try {
      const res = await fetch(fnBase + '/swift-handler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'create_user', email: newDriver.email, password: tempPass })
      })
      const json = await res.json()
      if (!res.ok) { setDriverMsg('Error: ' + (json.error || 'Failed to create auth account')); return }
    } catch (e: any) { setDriverMsg('Error: ' + e.message); return }
    const { data: inserted, error: insErr } = await supabase.from('drivers').insert([{
      name: newDriver.name, email: newDriver.email,
      phone: newDriver.phone || null, operator_license: newDriver.operator_license || null,
      assigned_properties: newDriver.assigned_properties,
      company: role?.company, is_active: true
    }]).select().single()
    if (insErr) { setDriverMsg('Auth created but driver insert failed: ' + insErr.message); return }
    await supabase.from('user_roles').insert([{ email: newDriver.email, role: 'driver', company: role?.company }])
    await auditLog('create_driver', 'drivers', inserted.id, { name: newDriver.name, email: newDriver.email, company: role?.company })
    setDriverMsg(`Driver created! Temp password: ${tempPass}`)
    setNewDriver({ name: '', email: '', phone: '', operator_license: '', assigned_properties: [] })
    setShowAddDriver(false)
    fetchCompanyDrivers()
  }

  async function updateDriver() {
    if (!editingDriver) return
    setDriverMsg('Saving...')
    const { error } = await supabase.from('drivers').update({
      name: editingDriver.name,
      phone: editingDriver.phone || null,
      operator_license: editingDriver.operator_license || null,
      assigned_properties: editingDriver.assigned_properties || [],
    }).eq('id', editingDriver.id)
    if (error) { setDriverMsg('Error: ' + error.message); return }
    await auditLog('update_driver', 'drivers', editingDriver.id, { name: editingDriver.name, company: role?.company })
    setDriverMsg('Driver updated!')
    setEditingDriver(null)
    fetchCompanyDrivers()
  }

  async function toggleDriverActive(driver: any) {
    const { error: updErr } = await supabase.from('drivers').update({ is_active: !driver.is_active }).eq('id', driver.id)
    if (updErr) { setDriverMsg('Error: ' + updErr.message); return }
    await auditLog(driver.is_active ? 'deactivate_driver' : 'activate_driver', 'drivers', driver.id, { is_active: !driver.is_active })
    fetchCompanyDrivers()
  }

  async function createFacility() {
    if (!newFacility.name || !newFacility.address) { setFacilityMsg('Name and address are required'); return }
    setFacilityMsg('Creating...')
    const { data, error: insErr } = await supabase.from('storage_facilities').insert([{
      name: newFacility.name, address: newFacility.address,
      phone: newFacility.phone || null, email: newFacility.email || null, is_active: true
    }]).select().single()
    if (insErr) { setFacilityMsg('Error: ' + insErr.message); return }
    await auditLog('create_facility', 'storage_facilities', data.id, newFacility)
    setFacilityMsg('Facility added!')
    setNewFacility({ name: '', address: '', phone: '', email: '' })
    setShowAddFacility(false)
    fetchAllFacilitiesManage()
    fetchStorageFacilities()
  }

  async function toggleUserActive(email: string, activate: boolean) {
    setTogglingUser(email)
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(fnBase + '/swift-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action: activate ? 'activate_user' : 'deactivate_user', email }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setUserMsg(json.error || json.message || 'Failed to update user status.')
    } else {
      setCompanyUsers(prev => prev.map(u => u.email === email ? { ...u, is_active: activate } : u))
    }
    setTogglingUser(null)
  }

  async function resetUserPassword() {
    if (!resetPwTarget) return
    if (resetPwForm.newPw.length < 8) { setResetPwMsg('Password must be at least 8 characters.'); return }
    if (resetPwForm.newPw !== resetPwForm.confirmPw) { setResetPwMsg('Passwords do not match.'); return }
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(fnBase + '/swift-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action: 'reset_password', email: resetPwTarget, new_password: resetPwForm.newPw }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setResetPwMsg(json.error || json.message || 'Failed to reset password.'); return }
    setResetPwMsg('Password reset successfully.')
    setTimeout(() => { setResetPwTarget(null); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }, 2000)
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
      const res = await fetch('/api/scan-plate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      })
      const json = await res.json()
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
    setSearching(true); setScanMsg(''); setResult(null); setShowViolation(false); setTicketTarget(null)
    const clean = val.toUpperCase().replace(/\s/g, '').trim()
    const companyPropNames = properties.map(p => (p.name || '').toLowerCase())

    const { data: activeVeh } = await supabase.from('vehicles').select('*').ilike('plate', clean).eq('is_active', true).single()
    if (activeVeh) {
      const inCompany = companyPropNames.includes((activeVeh.property || '').toLowerCase())
      if (inCompany) {
        if (selectedProperty && activeVeh.property?.toLowerCase() !== selectedProperty.name?.toLowerCase()) {
          setSearching(false); setResult({ status: 'otherproperty', data: activeVeh }); return
        }
        setSearching(false); setResult({ status: 'authorized', data: activeVeh }); return
      }
    }

    const { data: expiredVeh } = await supabase.from('vehicles').select('*').ilike('plate', clean).eq('is_active', false).single()
    if (expiredVeh) {
      const inCompany = companyPropNames.includes((expiredVeh.property || '').toLowerCase())
      if (inCompany) { setSearching(false); setResult({ status: 'expired', data: expiredVeh }); return }
    }

    const { data: companyResidents } = await supabase.from('residents').select('unit').in('property', properties.map(p => p.name))
    const companyUnits = [...new Set((companyResidents || []).map((r: any) => r.unit).filter(Boolean))]
    let pass = null
    if (companyUnits.length > 0) {
      const { data: passData } = await supabase.from('visitor_passes').select('*')
        .ilike('plate', clean).eq('is_active', true).gte('expires_at', new Date().toISOString())
        .in('visiting_unit', companyUnits).single()
      pass = passData
    }

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
      plate: plate.toUpperCase().trim(), violation_type: violation.type,
      location: violation.location, notes: violation.notes,
      property: violation.property, driver_name: role?.email, photos: photoUrls,
    }]).select().single()
    setSubmitting(false)
    if (insErr) { alert('Error: ' + insErr.message); return }
    await auditLog('ADD_VIOLATION', 'violations', newV?.id, { plate: plate.toUpperCase().trim(), property: violation.property, violation_type: violation.type })
    setShowViolation(false)
    setViolation({ type: '', location: '', notes: '', property: '' })
    setPhotos([])
    if (selectedProperty) fetchViolations(selectedProperty.name)
    if (newV) { setTicketTarget(newV); setSelectedStorage(''); setTowFee(''); setMileage('') }
  }

  function filteredViolations() {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const week = new Date(); week.setDate(week.getDate() - 7)
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    return violations.filter(v => {
      const d = new Date(v.created_at)
      const inPeriod = violationFilter === 'today' ? d >= today : violationFilter === 'week' ? d >= week : d >= sixmo
      if (!inPeriod) return false
      if (!violationSearch) return true
      const q = violationSearch.toLowerCase()
      return v.plate?.toLowerCase().includes(q) || v.violation_type?.toLowerCase().includes(q) || v.location?.toLowerCase().includes(q)
    })
  }

  function openTicketFor(v: any) {
    setTicketTarget(v); setExpandedTicketId(v.id)
    setSelectedStorage(''); setTowFee(''); setMileage(''); setVin('')
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
      ``,`VEHICLE`,`Plate: ${v.plate}`,
      `Vehicle: ${[v.year, v.color, v.make, v.model].filter(Boolean).join(' ') || '—'}`,
      `VIN: ${vin || v.vin || '—'}`,``,`VIOLATION`,
      `Type: ${v.violation_type || '—'}`,`Location: ${v.location || '—'}`,
      `Property: ${v.property || '—'}`,`Notes: ${v.notes || 'None'}`,
      ``,`STORAGE / IMPOUND`,`Facility: ${storage?.name || '—'}`,
      `Address: ${storage?.address || '—'}`,`Phone: ${storage?.phone || '—'}`,
      ``,`AUTHORIZED BY`,`Company: ${role?.company || '—'}`,
      ``,`FEES`,`Tow Fee: $${parseFloat(towFee || '0').toFixed(2)}`,
      `Mileage Fee: $${parseFloat(mileage || '0').toFixed(2)}`,`Total Due: $${total}`,
    ].join('\n'))
    const photosHtml = v.photos?.length
      ? `<div style="margin-top:20px"><p style="font-weight:bold;margin-bottom:8px">EVIDENCE PHOTOS</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${v.photos.map((u: string) => `<img src="${u}" style="width:100%;border-radius:4px;border:1px solid #ddd" onerror="this.style.display='none'">`).join('')}</div></div>`
      : ''
    tw.document.write(`<!DOCTYPE html><html><head><title>Tow Ticket — ${v.plate}</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;padding:28px;max-width:680px;margin:0 auto;color:#111;font-size:13px}
      .hdr{display:flex;align-items:center;gap:14px;margin-bottom:22px;padding-bottom:14px;border-bottom:3px solid #C9A227}
      .logo{width:64px;height:64px;border-radius:8px;border:2px solid #C9A227;object-fit:contain}
      .sec{margin-bottom:18px}.sh{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:8px;padding-bottom:3px;border-bottom:1px solid #eee}
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
      <div class="sec"><div class="sh">Vehicle Information</div><div class="g2">
        <div class="f"><label>License Plate</label><span class="plate">${v.plate}</span></div>
        <div class="f"><label>State</label><span>${v.state || '—'}</span></div>
        <div class="f"><label>Year / Make / Model</label><span>${[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}</span></div>
        <div class="f"><label>Color</label><span>${v.color || '—'}</span></div>
        <div class="f"><label>VIN</label><span>${vin || v.vin || '—'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Violation</div><div class="g2">
        <div class="f"><label>Type</label><span>${v.violation_type || '—'}</span></div>
        <div class="f"><label>Location / Space</label><span>${v.location || '—'}</span></div>
        <div class="f" style="grid-column:span 2"><label>Notes</label><span>${v.notes || 'No additional notes.'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Property</div><div class="g2">
        <div class="f"><label>Authorized By</label><span>${v.property || '—'}</span></div>
        <div class="f"><label>Company</label><span>${role?.company || '—'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Storage / Impound</div><div class="g2">
        <div class="f"><label>Facility</label><span>${storage?.name || '—'}</span></div>
        <div class="f"><label>Phone</label><span>${storage?.phone || '—'}</span></div>
        <div class="f" style="grid-column:span 2"><label>Address</label><span>${storage?.address || '—'}</span></div>
      </div></div>
      ${(parseFloat(towFee || '0') > 0 || parseFloat(mileage || '0') > 0) ? `
      <div class="sec"><div class="sh">Fees</div><div class="g2">
        ${parseFloat(towFee || '0') > 0 ? `<div class="f"><label>Tow Fee</label><span>$${parseFloat(towFee).toFixed(2)}</span></div>` : ''}
        ${parseFloat(mileage || '0') > 0 ? `<div class="f"><label>Mileage Fee</label><span>$${parseFloat(mileage).toFixed(2)}</span></div>` : ''}
        <div class="f"><label>Total Due</label><span style="font-size:16px;font-weight:bold">$${total}</span></div>
      </div></div>` : ''}
      ${photosHtml}
      <div class="sig-wrap"><div><div class="sig-line">Authorized Signature</div></div><div><div class="sig-line">Date</div></div></div>
      <div class="ftr">A1 Wrecker, LLC &middot; Houston's #1 Towing &amp; Recovery &middot; a1wreckerllc.net<br>Generated ${new Date().toLocaleString()}</div>
      <div class="no-print" style="margin-top:20px;display:flex;gap:10px;justify-content:center">
        <button onclick="window.print()" style="padding:11px 22px;background:#C9A227;color:#0f1117;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Print Ticket</button>
        <a href="mailto:?subject=${mailSubject}&body=${mailBody}" style="padding:11px 22px;background:#1e3a5f;color:#fff;font-weight:bold;font-size:13px;border-radius:7px;text-decoration:none;display:inline-flex;align-items:center">Email Ticket</a>
        <button onclick="window.close()" style="padding:11px 22px;background:#333;color:#fff;font-size:13px;border:none;border-radius:7px;cursor:pointer">Close</button>
      </div>
    </body></html>`)
    tw.document.close()
  }

  function renderTicketForm() {
    if (!ticketTarget) return null
    return (
      <div style={{ background:'#0d1520', border:'2px solid #C9A227', borderRadius:'10px', padding:'16px', marginTop:'12px' }}>
        <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'14px', margin:'0 0 14px' }}>
          Generate Tow Ticket — <span style={{ fontFamily:'Courier New' }}>{ticketTarget.plate}</span>
        </p>
        <label style={lbl}>Storage Facility *</label>
        <select value={selectedStorage} onChange={e => setSelectedStorage(e.target.value)} style={inp}>
          <option value=''>Select storage facility...</option>
          {storageFacilities.map((s, i) => <option key={i} value={s.id}>{s.name} — {s.address}</option>)}
        </select>
        <label style={lbl}>VIN</label>
        <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN" style={inp} />
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
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
          <p style={{ color:'#C9A227', fontSize:'12px', margin:'-6px 0 10px', textAlign:'right', fontWeight:'bold' }}>
            Total: ${(parseFloat(towFee || '0') + parseFloat(mileage || '0')).toFixed(2)}
          </p>
        )}
        <div style={{ display:'flex', gap:'8px' }}>
          <button onClick={generateTicket} disabled={!selectedStorage}
            style={{ flex:1, padding:'11px', background:!selectedStorage ? '#2a2f3d' : '#C9A227', color:!selectedStorage ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:!selectedStorage ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
            Print Tow Ticket
          </button>
          <button onClick={() => { setTicketTarget(null); setExpandedTicketId(null) }}
            style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
            Close
          </button>
        </div>
      </div>
    )
  }

  function printQRSign(canvasId: string, title: string, subtitle: string) {
    const container = document.getElementById(canvasId)
    const canvas = container?.querySelector('canvas') as HTMLCanvasElement | null
    const dataUrl = canvas?.toDataURL('image/png') || ''
    const tw = window.open('', '_blank')
    if (!tw) return
    tw.document.write(`<!DOCTYPE html><html><head><title>Visitor Parking Sign</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;background:white;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
      .card{max-width:380px;width:100%;text-align:center;border:3px solid #C9A227;border-radius:16px;padding:32px;margin:0 auto}
      .hdr{background:#0f1117;border-radius:8px;padding:12px;margin-bottom:20px}
      .note{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;margin-top:14px}
      .warn{background:#f8d7da;border:1px solid #f5c6cb;border-radius:6px;padding:10px;margin-top:10px}
      @media print{body{min-height:auto}}
    </style></head><body>
      <div class="card">
        <div class="hdr">
          <p style="color:#C9A227;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em">A1 WRECKER, LLC</p>
          <p style="color:white;font-size:10px;margin-top:2px">Houston's #1 Towing &amp; Recovery</p>
        </div>
        <p style="font-size:22px;font-weight:bold;color:#111;margin-bottom:4px">Visitor Parking</p>
        <p style="font-size:14px;color:#333;margin-bottom:20px">Scan to get your parking pass</p>
        <img src="${dataUrl}" style="width:200px;height:200px;display:block;margin:0 auto 16px" />
        <p style="font-size:15px;font-weight:bold;color:#111;margin-bottom:4px">${title}</p>
        <p style="font-size:11px;color:#555;margin-bottom:0">${subtitle}</p>
        <div class="note"><p style="color:#856404;font-size:12px;font-weight:bold;margin-bottom:2px">Required before parking</p><p style="color:#856404;font-size:11px">Valid up to 24 hours · No app download needed</p></div>
        <div class="warn"><p style="color:#721c24;font-size:12px;font-weight:bold;margin-bottom:2px">⚠ Unregistered vehicles will be towed</p><p style="color:#721c24;font-size:11px">without notice at owner's expense</p></div>
      </div>
      <script>window.onload=function(){window.print()}</script>
    </body></html>`)
    tw.document.close()
  }

  const tab = (t: string): React.CSSProperties => ({
    flex:1, padding:'8px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold', fontSize:'11px',
    background: activeTab === t ? '#C9A227' : '#1e2535',
    color: activeTab === t ? '#0f1117' : '#888',
    fontFamily:'Arial, sans-serif'
  })

  const inp: React.CSSProperties = {
    display:'block', width:'100%', marginTop:'6px', marginBottom:'10px',
    padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055',
    borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box'
  }

  const lbl: React.CSSProperties = {
    color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em'
  }

  const msgBox = (msg: string) => {
    const isErr = msg.startsWith('Error') || msg.includes('failed')
    return (
      <div style={{ background: isErr ? '#3a1a1a' : '#1a3a1a', border: `1px solid ${isErr ? '#b71c1c' : '#2e7d32'}`, borderRadius:'8px', padding:'10px 12px', marginBottom:'10px' }}>
        <p style={{ color: isErr ? '#f44336' : '#4caf50', fontSize:'12px', margin:'0', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>{msg}</p>
      </div>
    )
  }

  const addBtn = (label: string, onClick: () => void) => (
    <button onClick={onClick}
      style={{ width:'100%', padding:'11px', background:'#1e2535', color:'#C9A227', border:'1px dashed #C9A227', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontWeight:'bold', fontFamily:'Arial', marginBottom:'12px' }}>
      {label}
    </button>
  )

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )


  const fvs = filteredViolations()
  const isCA = role?.role === 'company_admin'

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'540px', margin:'0 auto' }}>

        <div style={{ marginBottom:'16px', textAlign:'center' }}>
          <img src="/logo.jpeg" alt="A1 Wrecker"
            style={{ width:'60px', height:'60px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 8px' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Company Admin Portal</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 16px', marginBottom:'14px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>{role?.company || 'Company Admin'}</p>
            <p style={{ color:'#aaa', fontSize:'11px', margin:'2px 0 0' }}>{user?.email}</p>
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
            style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
            Sign Out
          </button>
        </div>

        {properties.length > 1 && (
          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Viewing Property</label>
            <select onChange={e => switchProperty(e.target.value)} value={selectedProperty?.name || ''} style={{ ...inp, marginTop:'6px', fontSize:'13px' }}>
              {properties.map((p, i) => <option key={i} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}

        {selectedProperty && (
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 16px', marginBottom:'14px' }}>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0' }}>{selectedProperty.name}</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{selectedProperty.address || ''}{selectedProperty.pm_name ? ` · ${selectedProperty.pm_name}` : ''}</p>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'8px', marginBottom:'14px' }}>
          {[
            { label:'Vehicles', value:stats.total_vehicles, color:'#C9A227' },
            { label:'Today', value:stats.violations_today, color:'#f44336' },
            { label:'This Week', value:stats.violations_week, color:'#ff9800' },
            { label:'Visitors', value:stats.active_passes, color:'#4caf50' },
          ].map((s, i) => (
            <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', textAlign:'center' }}>
              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0' }}>{s.label}</p>
              <p style={{ color:s.color, fontSize:'24px', fontWeight:'bold', margin:'4px 0 0', fontFamily:'Courier New' }}>{s.value}</p>
            </div>
          ))}
        </div>

        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'14px' }}>
          <button style={tab('overview')} onClick={() => setActiveTab('overview')}>Overview</button>
          <button style={tab('lookup')} onClick={() => setActiveTab('lookup')}>Plate Lookup</button>
          <button style={tab('violations')} onClick={() => setActiveTab('violations')}>Violations</button>
          <button style={tab('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
          <button style={tab('qrcodes')} onClick={() => setActiveTab('qrcodes')}>QR Codes</button>
          <button style={tab('manage')} onClick={() => { setActiveTab('manage'); if (!manageLoaded) loadManageData() }}>Manage</button>
        </div>

        {/* ── OVERVIEW ── */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Recent Violations</p>
              {violations.slice(0, 5).length === 0
                ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No violations found</p>
                : violations.slice(0, 5).map((v, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                    <span style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                    <span style={{ color:'#aaa', fontSize:'12px' }}>{v.violation_type || '—'}</span>
                    <span style={{ color:'#555', fontSize:'11px' }}>{new Date(v.created_at).toLocaleDateString()}</span>
                  </div>
                ))
              }
            </div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Active Visitor Passes</p>
              {passes.length === 0
                ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No active visitor passes</p>
                : passes.map((p, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                    <span style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{p.plate}</span>
                    <span style={{ color:'#aaa', fontSize:'12px' }}>{p.visiting_unit}</span>
                    <span style={{ color:'#4caf50', fontSize:'11px' }}>Exp {new Date(p.expires_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</span>
                  </div>
                ))
              }
            </div>
          </div>
        )}

        {/* ── PLATE LOOKUP ── */}
        {activeTab === 'lookup' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'22px', marginBottom:'14px' }}>
              <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.1em' }}>License Plate</label>
              <button onClick={openCamera}
                style={{ width:'100%', padding:'12px', background:'#1a1f2e', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', cursor:'pointer', fontSize:'14px', fontWeight:'bold', marginTop:'8px', marginBottom:'8px', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', fontFamily:'Arial' }}>
                📷 Scan License Plate
              </button>
              <input value={plate} onChange={e => { setPlate(e.target.value.toUpperCase().replace(/\s/g, '')); setResult(null); setTicketTarget(null); setScanMsg('') }}
                onKeyDown={e => e.key === 'Enter' && searchPlate()} placeholder="ABC1234" maxLength={10}
                style={{ display:'block', width:'100%', padding:'16px', fontSize:'28px', fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.12em', background:'#1e2535', border:'2px solid #3a4055', borderRadius:'10px', color:'white', textAlign:'center', outline:'none', boxSizing:'border-box', textTransform:'uppercase' }}
              />
              {scanMsg && (
                <p style={{ color:'#C9A227', fontSize:'12px', margin:'4px 0 0', fontStyle:'italic' }}>{scanMsg}</p>
              )}
              <button onClick={() => searchPlate()} disabled={searching || !plate}
                style={{ marginTop:'12px', width:'100%', padding:'14px', background:!plate ? '#2a2f3d' : '#C9A227', color:!plate ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor:!plate ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                {searching ? 'Searching...' : 'Search Plate'}
              </button>

              {result && (
                <div style={{ marginTop:'16px', padding:'16px', borderRadius:'10px',
                  background: result.status === 'authorized' ? '#061406' : result.status === 'visitor' ? '#150f00' : '#140404',
                  border:`1px solid ${result.status === 'authorized' ? '#2e7d32' : result.status === 'visitor' ? '#a16207' : '#991b1b'}`
                }}>
                  {result.status === 'authorized' && (
                    <>
                      <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'16px', margin:'0 0 12px' }}>✓ AUTHORIZED</p>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Unit</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.unit}</span></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Space</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.space || '—'}</span></div>
                        <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Vehicle</span><br /><span style={{ color:'white', fontSize:'13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                        <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Property</span><br /><span style={{ color:'#4caf50', fontSize:'13px' }}>{result.data.property}</span></div>
                      </div>
                    </>
                  )}
                  {result.status === 'expired' && (
                    <>
                      <p style={{ color:'#ff9800', fontWeight:'bold', fontSize:'16px', margin:'0 0 12px' }}>⚠ PERMIT EXPIRED</p>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Unit</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.unit}</span></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Space</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.space || '—'}</span></div>
                        <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Vehicle</span><br /><span style={{ color:'white', fontSize:'13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                      </div>
                      <button onClick={() => setShowViolation(true)}
                        style={{ width:'100%', padding:'11px', background:'#991b1b', color:'white', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}
                  {result.status === 'visitor' && (
                    <>
                      <p style={{ color:'#f59e0b', fontWeight:'bold', fontSize:'16px', margin:'0 0 12px' }}>✓ VISITOR PASS ACTIVE</p>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Visiting Unit</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.visiting_unit}</span></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Visitor Name</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.visitor_name || '—'}</span></div>
                        <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Expires</span><br /><span style={{ color:'#f59e0b', fontWeight:'bold', fontSize:'13px' }}>{new Date(result.data.expires_at).toLocaleString()}</span></div>
                      </div>
                      <p style={{ color:'#f59e0b', fontSize:'11px', margin:'10px 0 0', fontWeight:'bold' }}>Do not tow — active visitor pass</p>
                    </>
                  )}
                  {result.status === 'otherproperty' && (
                    <>
                      <p style={{ color:'#ff9800', fontWeight:'bold', fontSize:'16px', margin:'0 0 6px' }}>⚠ DIFFERENT PROPERTY</p>
                      <p style={{ color:'#aaa', fontSize:'13px', margin:'0' }}>This plate is registered to <strong style={{ color:'white' }}>{result.data.property}</strong>, not the currently selected property.</p>
                    </>
                  )}
                  {result.status === 'notfound' && (
                    <>
                      <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'16px', margin:'0 0 6px' }}>✗ NO PERMIT FOUND</p>
                      <p style={{ color:'#aaa', fontSize:'13px', margin:'0 0 12px' }}>Plate is not registered. Vehicle may be towed.</p>
                      <button onClick={() => setShowViolation(true)}
                        style={{ width:'100%', padding:'11px', background:'#991b1b', color:'white', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}
                </div>
              )}

              {showViolation && (
                <div style={{ marginTop:'14px', background:'#0f0505', border:'1px solid #991b1b', borderRadius:'10px', padding:'16px' }}>
                  <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'14px', margin:'0 0 14px' }}>
                    Issue Violation — <span style={{ fontFamily:'Courier New' }}>{plate}</span>
                  </p>
                  <label style={lbl}>Property *</label>
                  <select value={violation.property} onChange={e => setViolation({ ...violation, property: e.target.value })} style={inp}>
                    <option value=''>Select property...</option>
                    {properties.map((p, i) => <option key={i} value={p.name}>{p.name}</option>)}
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
                  <label style={lbl}>Notes</label>
                  <textarea value={violation.notes} onChange={e => setViolation({ ...violation, notes: e.target.value })}
                    placeholder="Additional details..." style={{ ...inp, minHeight:'60px', resize:'vertical' as const }} />
                  <label style={lbl}>Photos</label>
                  <input type="file" accept="image/*" multiple onChange={e => setPhotos(Array.from(e.target.files || []))}
                    style={{ display:'block', width:'100%', marginBottom:'8px', color:'#aaa', fontSize:'12px' }} />
                  {photos.length > 0 && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'6px', marginBottom:'10px' }}>
                      {photos.map((f, i) => (
                        <img key={i} src={URL.createObjectURL(f)} alt={f.name}
                          style={{ width:'60px', height:'60px', objectFit:'cover', borderRadius:'6px', border:'1px solid #3a4055' }} />
                      ))}
                    </div>
                  )}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={submitViolation} disabled={submitting}
                      style={{ flex:1, padding:'11px', background:submitting ? '#555' : '#991b1b', color:'white', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:submitting ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                      {submitting ? 'Submitting...' : 'Submit Violation'}
                    </button>
                    <button onClick={() => setShowViolation(false)}
                      style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            {ticketTarget && activeTab === 'lookup' && renderTicketForm()}
          </div>
        )}

        {/* ── VIOLATIONS ── */}
        {activeTab === 'violations' && (
          <div>
            <input value={violationSearch} onChange={e => setViolationSearch(e.target.value)}
              placeholder="Search plate, violation type, location..."
              style={{ ...inp, fontSize:'13px', padding:'11px 12px', marginBottom:'10px' }}
            />
            <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex:1, padding:'8px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', background:violationFilter === f.k ? '#C9A227' : 'transparent', color:violationFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>
            <p style={{ color:'#444', fontSize:'11px', margin:'0 0 10px', textAlign:'right' }}>{fvs.length} result{fvs.length !== 1 ? 's' : ''}</p>
            {fvs.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations found for this period</p>
              </div>
            ) : fvs.map((v, i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                  <div>
                    <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{v.violation_type || '—'}</p>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                    <p style={{ color:'#444', fontSize:'10px', margin:'2px 0 0' }}>{new Date(v.created_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</p>
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontSize:'12px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Location</span><br /><span style={{ color:'#aaa' }}>{v.location || '—'}</span></div>
                  {v.driver_name && <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Issued By</span><br /><span style={{ color:'#aaa' }}>{v.driver_name}</span></div>}
                  {v.notes && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Notes</span><br /><span style={{ color:'#aaa' }}>{v.notes}</span></div>}
                </div>
                {v.photos && v.photos.length > 0 && (
                  <div style={{ marginBottom:'10px' }}>
                    <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', margin:'0 0 6px' }}>Evidence Photos</p>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px' }}>
                      {v.photos.map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt={`Photo ${pi + 1}`} style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                <button onClick={() => expandedTicketId === v.id ? (setExpandedTicketId(null), setTicketTarget(null)) : openTicketFor(v)}
                  style={{ width:'100%', padding:'9px', background:expandedTicketId === v.id ? '#1a1200' : '#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                  {expandedTicketId === v.id ? '▲ Close Ticket' : 'Generate Tow Ticket'}
                </button>
                {expandedTicketId === v.id && renderTicketForm()}
              </div>
            ))}
          </div>
        )}

        {/* ── VISITORS ── */}
        {activeTab === 'visitors' && (
          <div>
            {passes.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active visitor passes</p>
              </div>
            ) : passes.map((p, i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'10px' }}>
                  <p style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{p.plate}</p>
                  <span style={{ background:'#1a3a1a', color:'#4caf50', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>Active</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                  <div><span style={{ color:'#555' }}>Visiting</span><br /><span style={{ color:'#aaa' }}>{p.visiting_unit}</span></div>
                  <div><span style={{ color:'#555' }}>Visitor</span><br /><span style={{ color:'#aaa' }}>{p.visitor_name || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Vehicle</span><br /><span style={{ color:'#aaa' }}>{p.vehicle_desc || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Duration</span><br /><span style={{ color:'#aaa' }}>{p.duration_hours} hours</span></div>
                  <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Expires</span><br /><span style={{ color:'#f59e0b' }}>{new Date(p.expires_at).toLocaleString()}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── QR CODES ── */}
        {activeTab === 'qrcodes' && (
          <div>
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Individual Property QR Codes</p>

            {properties.map((prop, i) => {
              const url = `${BASE_URL}/visitor?property=${encodeURIComponent(prop.name)}`
              const canvasId = `qr-prop-${i}`
              return (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', marginBottom:'12px', textAlign:'center' }}>
                  <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 16px' }}>{prop.name}</p>
                  <div id={canvasId} style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                    <QRCodeCanvas value={url} size={160} level="H" includeMargin={true} />
                  </div>
                  <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New' }}>{url}</p>
                  <button onClick={() => printQRSign(canvasId, prop.name, prop.address || '')}
                    style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>
                    Print This Sign
                  </button>
                </div>
              )
            })}

            {properties.length === 0 && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center', marginBottom:'12px' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No properties assigned</p>
              </div>
            )}

            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'20px 0 4px' }}>Multi-Property QR Code</p>
            <p style={{ color:'#888', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>Use this QR code when visitors need to choose which property they are visiting.</p>

            {(() => {
              const companyUrl = `${BASE_URL}/visitor-select?company=${encodeURIComponent(role?.company || '')}`
              return (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', marginBottom:'12px', textAlign:'center' }}>
                  <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>Company Visitor Pass — Visitor Selects Property</p>
                  <p style={{ color:'#888', fontSize:'12px', margin:'0 0 16px', lineHeight:'1.5' }}>Visitors scan this once and then pick which property they are visiting.</p>
                  <div id="qr-company" style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                    <QRCodeCanvas value={companyUrl} size={160} level="H" includeMargin={true} />
                  </div>
                  <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New' }}>{companyUrl}</p>
                  <button onClick={() => printQRSign('qr-company', role?.company || '', 'Select your property after scanning')}
                    style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>
                    Print This Sign
                  </button>
                </div>
              )
            })()}

            {/* Registration QR Codes */}
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'20px 0 4px' }}>Resident Registration QR Codes</p>
            <p style={{ color:'#888', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>Share these with new residents so they can self-register. Their account requires manager approval before login.</p>

            {properties.map((prop, i) => {
              const regUrl = `${BASE_URL}/register?property=${encodeURIComponent(prop.name)}&company=${encodeURIComponent(role?.company || '')}`
              const canvasId = `qr-reg-${i}`
              return (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', marginBottom:'12px', textAlign:'center' }}>
                  <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>{prop.name}</p>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>New Resident Registration</p>
                  <div id={canvasId} style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                    <QRCodeCanvas value={regUrl} size={160} level="H" includeMargin={true} />
                  </div>
                  <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New' }}>{regUrl}</p>
                  <button onClick={() => {
                    const canvas = document.querySelector(`#${canvasId} canvas`) as HTMLCanvasElement
                    if (!canvas) return
                    const tw = window.open('', '_blank')!
                    tw.document.write(`<html><head><title>Registration QR - ${prop.name}</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:Arial,sans-serif;padding:40px}img{width:220px;height:220px}h2{color:#1A1F2E;font-size:22px;margin:16px 0 8px}p{color:#555;font-size:13px;text-align:center;max-width:320px;margin:4px 0}a{color:#C9A227;font-size:11px;word-break:break-all}</style></head><body><img src="${canvas.toDataURL()}" /><h2>${prop.name}</h2><p>Scan to register as a new resident</p><p>Your account requires manager approval before login</p><a>${regUrl}</a><script>window.print();window.close();</script></body></html>`)
                    tw.document.close()
                  }} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>
                    Print This Sign
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* ── MANAGE ── */}
        {activeTab === 'manage' && (
          <div>
            {/* Sub-tab bar */}
            <div style={{ display:'flex', gap:'3px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'14px' }}>
              {(['properties', 'users', 'drivers', 'storage', 'auditlog'] as const).map(s => (
                <button key={s}
                  onClick={() => { setManageSection(s); if (s === 'auditlog') fetchCompanyAuditLogs() }}
                  style={{
                    flex:1, padding:'7px 4px', border:'none', borderRadius:'6px', cursor:'pointer',
                    fontWeight:'bold', fontSize:'10px', fontFamily:'Arial, sans-serif',
                    background: manageSection === s ? '#C9A227' : 'transparent',
                    color: manageSection === s ? '#0f1117' : '#888',
                  }}>
                  {s === 'properties' ? 'Properties' : s === 'users' ? 'Users' : s === 'drivers' ? 'Drivers' : s === 'storage' ? 'Storage' : 'Audit Log'}
                </button>
              ))}
            </div>

            {/* SECTION 1 — Properties */}
            {manageSection === 'properties' && (
              <div>
                {propMsg && msgBox(propMsg)}
                {isCA && addBtn('+ Add Property', () => { setShowAddProperty(true); setPropMsg('') })}

                {showAddProperty && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Property</p>
                    {[
                      { key:'name', label:'Property Name *', placeholder:'Sunset Apartments' },
                      { key:'address', label:'Address', placeholder:'123 Main St' },
                      { key:'city', label:'City', placeholder:'Houston' },
                      { key:'state', label:'State', placeholder:'TX' },
                      { key:'zip', label:'ZIP Code', placeholder:'77001' },
                      { key:'total_spaces', label:'Total Spaces', placeholder:'120' },
                      { key:'pm_name', label:'Property Manager Name', placeholder:'John Smith' },
                      { key:'pm_phone', label:'PM Phone', placeholder:'(713) 555-0123' },
                      { key:'pm_email', label:'PM Email', placeholder:'pm@example.com' },
                    ].map(f => (
                      <div key={f.key}>
                        <label style={lbl}>{f.label}</label>
                        <input value={(newProperty as any)[f.key]} onChange={e => setNewProperty({ ...newProperty, [f.key]: e.target.value })} placeholder={f.placeholder} style={inp} />
                      </div>
                    ))}
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={saveProperty} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Save Property</button>
                      <button onClick={() => { setShowAddProperty(false); setPropMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
                  <button onClick={() => setShowActiveProps(s => !s)} style={{ padding:'4px 10px', background: showActiveProps ? '#1a1f2e' : '#111', color: showActiveProps ? '#C9A227' : '#555', border:`1px solid ${showActiveProps ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial' }}>{showActiveProps ? '● Active Only' : '○ Show All'}</button>
                </div>
                {(showActiveProps ? properties.filter(p => p.is_active) : properties).map((prop, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px', opacity: !showActiveProps && !prop.is_active ? 0.5 : 1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'4px' }}>
                      <div style={{ flex:1 }}>
                        <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>{prop.name}</p>
                        {prop.address && <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{prop.address}{prop.city ? `, ${prop.city}` : ''}{prop.state ? ` ${prop.state}` : ''}{prop.zip ? ` ${prop.zip}` : ''}</p>}
                        {prop.pm_name && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>PM: {prop.pm_name}{prop.pm_phone ? ` · ${prop.pm_phone}` : ''}</p>}
                        {prop.total_spaces && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{prop.total_spaces} spaces</p>}
                      </div>
                      <span style={{ background: prop.is_active ? '#1a3a1a' : '#2a1a1a', color: prop.is_active ? '#4caf50' : '#f44336', padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold', flexShrink:0 }}>
                        {prop.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {isCA && (
                      <div style={{ display:'flex', gap:'6px', marginTop:'10px' }}>
                        <button onClick={() => { setEditingProperty({ ...prop, total_spaces: prop.total_spaces ? String(prop.total_spaces) : '' }); setPropMsg('') }}
                          style={{ flex:1, padding:'7px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Edit</button>
                        <button onClick={() => togglePropertyActive(prop)}
                          style={{ flex:1, padding:'7px', background: prop.is_active ? '#3a1a1a' : '#1a3a1a', color: prop.is_active ? '#f44336' : '#4caf50', border:`1px solid ${prop.is_active ? '#b71c1c' : '#2e7d32'}`, borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          {prop.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    )}
                    {editingProperty?.id === prop.id && isCA && (
                      <div style={{ marginTop:'12px', padding:'12px', background:'#0d1520', borderRadius:'8px', border:'1px solid #3a4055' }}>
                        {[
                          { key:'name', label:'Name *' }, { key:'address', label:'Address' },
                          { key:'city', label:'City' }, { key:'state', label:'State' },
                          { key:'zip', label:'ZIP' }, { key:'total_spaces', label:'Total Spaces' },
                          { key:'pm_name', label:'PM Name' }, { key:'pm_phone', label:'PM Phone' },
                          { key:'pm_email', label:'PM Email' },
                        ].map(f => (
                          <div key={f.key}>
                            <label style={lbl}>{f.label}</label>
                            <input value={(editingProperty as any)[f.key] || ''} onChange={e => setEditingProperty({ ...editingProperty, [f.key]: e.target.value })} style={inp} />
                          </div>
                        ))}
                        <div style={{ display:'flex', gap:'6px' }}>
                          <button onClick={updateProperty} style={{ flex:1, padding:'9px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>Save Changes</button>
                          <button onClick={() => setEditingProperty(null)} style={{ padding:'9px 10px', background:'#1e2535', color:'#aaa', fontSize:'11px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {properties.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No properties found</p></div>}
              </div>
            )}

            {/* SECTION 2 — Users */}
            {manageSection === 'users' && (
              <div>
                {userMsg && msgBox(userMsg)}
                {isCA && addBtn('+ Add User', () => { setShowAddUser(true); setUserMsg('') })}

                {showAddUser && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New User</p>
                    <label style={lbl}>Email *</label>
                    <input type="email" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} placeholder="user@example.com" style={inp} />
                    <label style={lbl}>Password *</label>
                    <input type="password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} placeholder="Temporary password" style={inp} />
                    <label style={lbl}>Role *</label>
                    <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })} style={inp}>
                      <option value="manager">Manager</option>
                      <option value="leasing_agent">Leasing Agent</option>
                      <option value="driver">Driver</option>
                      <option value="resident">Resident</option>
                    </select>
                    <label style={lbl}>Property</label>
                    <select value={newUser.property} onChange={e => setNewUser({ ...newUser, property: e.target.value })} style={inp}>
                      <option value="">No specific property</option>
                      {properties.map((p, i) => <option key={i} value={p.name}>{p.name}</option>)}
                    </select>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={createUser} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Create User</button>
                      <button onClick={() => { setShowAddUser(false); setUserMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
                  <button onClick={() => setShowActiveCompanyUsers(s => !s)} style={{ padding:'4px 10px', background: showActiveCompanyUsers ? '#1a1f2e' : '#111', color: showActiveCompanyUsers ? '#C9A227' : '#555', border:`1px solid ${showActiveCompanyUsers ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial' }}>{showActiveCompanyUsers ? '● Active Only' : '○ Show All'}</button>
                </div>
                {(showActiveCompanyUsers ? companyUsers.filter(u => u.is_active !== false) : companyUsers).map((u, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'8px', opacity: !showActiveCompanyUsers && u.is_active === false ? 0.5 : 1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{u.email}</p>
                        {u.property && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{u.property}</p>}
                      </div>
                      <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
                        {(u.role === 'manager' || u.role === 'leasing_agent') && (
                          <span style={{ background: u.is_active !== false ? '#1a3a1a' : '#3a1a1a', color: u.is_active !== false ? '#4caf50' : '#f44336', padding:'2px 6px', borderRadius:'8px', fontSize:'9px', fontWeight:'bold' }}>
                            {u.is_active !== false ? 'Active' : 'Inactive'}
                          </span>
                        )}
                        <span style={{ background:'#1e2535', color:'#C9A227', padding:'3px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', textTransform:'capitalize' as const }}>
                          {u.role.replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' as const }}>
                      <button onClick={() => { setResetPwTarget(resetPwTarget === u.email ? null : u.email); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }}
                        style={{ padding:'4px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                        {resetPwTarget === u.email ? 'Cancel' : 'Reset Password'}
                      </button>
                      {(u.role === 'manager' || u.role === 'leasing_agent') && (
                        u.is_active !== false ? (
                          <button onClick={() => toggleUserActive(u.email, false)} disabled={togglingUser === u.email}
                            style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                            {togglingUser === u.email ? '...' : 'Deactivate'}
                          </button>
                        ) : (
                          <button onClick={() => toggleUserActive(u.email, true)} disabled={togglingUser === u.email}
                            style={{ padding:'4px 10px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                            {togglingUser === u.email ? '...' : 'Activate'}
                          </button>
                        )
                      )}
                    </div>
                    {resetPwTarget === u.email && (
                      <div style={{ marginTop:'10px', borderTop:'1px solid #2a2f3d', paddingTop:'10px' }}>
                        <input type="password" value={resetPwForm.newPw} onChange={e => setResetPwForm(f => ({...f, newPw: e.target.value}))}
                          placeholder="New password (min 8 chars)" style={{ ...inp, marginBottom:'8px' }} />
                        <input type="password" value={resetPwForm.confirmPw} onChange={e => setResetPwForm(f => ({...f, confirmPw: e.target.value}))}
                          placeholder="Confirm new password" style={{ ...inp, marginBottom:'8px' }} />
                        {resetPwMsg && (
                          <p style={{ color: resetPwMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0 0 8px' }}>{resetPwMsg}</p>
                        )}
                        <button onClick={resetUserPassword}
                          style={{ width:'100%', padding:'8px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                          Save New Password
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {companyUsers.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No users found</p></div>}
              </div>
            )}

            {/* SECTION 3 — Drivers */}
            {manageSection === 'drivers' && (
              <div>
                {driverMsg && msgBox(driverMsg)}
                {isCA && addBtn('+ Add Driver', () => { setShowAddDriver(true); setDriverMsg('') })}

                {showAddDriver && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Driver</p>
                    <label style={lbl}>Full Name *</label>
                    <input value={newDriver.name} onChange={e => setNewDriver({ ...newDriver, name: e.target.value })} placeholder="Jane Doe" style={inp} />
                    <label style={lbl}>Email *</label>
                    <input type="email" value={newDriver.email} onChange={e => setNewDriver({ ...newDriver, email: e.target.value })} placeholder="driver@example.com" style={inp} />
                    <label style={lbl}>Phone</label>
                    <input value={newDriver.phone} onChange={e => setNewDriver({ ...newDriver, phone: e.target.value })} placeholder="(713) 555-0123" style={inp} />
                    <label style={lbl}>Operator License</label>
                    <input value={newDriver.operator_license} onChange={e => setNewDriver({ ...newDriver, operator_license: e.target.value })} placeholder="License number" style={inp} />
                    <label style={lbl}>Assigned Properties</label>
                    <div style={{ marginTop:'6px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px' }}>
                      <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer', borderBottom:'1px solid #2a2f3d', marginBottom:'4px' }}>
                        <input type="checkbox"
                          checked={newDriver.assigned_properties.length === properties.length && properties.length > 0}
                          onChange={e => setNewDriver({ ...newDriver, assigned_properties: e.target.checked ? properties.map(p => p.name) : [] })}
                          style={{ accentColor:'#C9A227', cursor:'pointer' }}
                        />
                        <span style={{ color:'#C9A227', fontSize:'12px', fontWeight:'bold' }}>Select All</span>
                      </label>
                      {properties.map((p, i) => (
                        <label key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer' }}>
                          <input type="checkbox"
                            checked={newDriver.assigned_properties.includes(p.name)}
                            onChange={e => {
                              if (e.target.checked) setNewDriver({ ...newDriver, assigned_properties: [...newDriver.assigned_properties, p.name] })
                              else setNewDriver({ ...newDriver, assigned_properties: newDriver.assigned_properties.filter(n => n !== p.name) })
                            }}
                            style={{ accentColor:'#C9A227', cursor:'pointer' }}
                          />
                          <span style={{ color:'#aaa', fontSize:'12px' }}>{p.name}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={createDriver} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Create Driver</button>
                      <button onClick={() => { setShowAddDriver(false); setDriverMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                {editingDriver && (
                  <div style={{ background:'#0d1520', border:'2px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Edit Driver — {editingDriver.name}</p>
                    <label style={lbl}>Full Name</label>
                    <input value={editingDriver.name || ''} onChange={e => setEditingDriver({ ...editingDriver, name: e.target.value })} style={inp} />
                    <label style={lbl}>Phone</label>
                    <input value={editingDriver.phone || ''} onChange={e => setEditingDriver({ ...editingDriver, phone: e.target.value })} style={inp} />
                    <label style={lbl}>Operator License</label>
                    <input value={editingDriver.operator_license || ''} onChange={e => setEditingDriver({ ...editingDriver, operator_license: e.target.value })} style={inp} />
                    <label style={lbl}>Assigned Properties</label>
                    <div style={{ marginTop:'6px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px' }}>
                      <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer', borderBottom:'1px solid #2a2f3d', marginBottom:'4px' }}>
                        <input type="checkbox"
                          checked={(editingDriver.assigned_properties || []).length === properties.length && properties.length > 0}
                          onChange={e => setEditingDriver({ ...editingDriver, assigned_properties: e.target.checked ? properties.map(p => p.name) : [] })}
                          style={{ accentColor:'#C9A227', cursor:'pointer' }}
                        />
                        <span style={{ color:'#C9A227', fontSize:'12px', fontWeight:'bold' }}>Select All</span>
                      </label>
                      {properties.map((p, i) => (
                        <label key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer' }}>
                          <input type="checkbox"
                            checked={(editingDriver.assigned_properties || []).includes(p.name)}
                            onChange={e => {
                              const cur: string[] = editingDriver.assigned_properties || []
                              if (e.target.checked) setEditingDriver({ ...editingDriver, assigned_properties: [...cur, p.name] })
                              else setEditingDriver({ ...editingDriver, assigned_properties: cur.filter((n: string) => n !== p.name) })
                            }}
                            style={{ accentColor:'#C9A227', cursor:'pointer' }}
                          />
                          <span style={{ color:'#aaa', fontSize:'12px' }}>{p.name}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={updateDriver} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Save Changes</button>
                      <button onClick={() => { setEditingDriver(null); setDriverMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
                  <button onClick={() => setShowActiveCompanyDrivers(s => !s)} style={{ padding:'4px 10px', background: showActiveCompanyDrivers ? '#1a1f2e' : '#111', color: showActiveCompanyDrivers ? '#C9A227' : '#555', border:`1px solid ${showActiveCompanyDrivers ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial' }}>{showActiveCompanyDrivers ? '● Active Only' : '○ Show All'}</button>
                </div>
                {(showActiveCompanyDrivers ? companyDrivers.filter(d => d.is_active) : companyDrivers).map((d, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'8px', opacity: !showActiveCompanyDrivers && !d.is_active ? 0.5 : 1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{d.name}</p>
                        <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{d.email}</p>
                        {d.phone && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{d.phone}</p>}
                        {d.operator_license && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>Lic: {d.operator_license}</p>}
                        {d.assigned_properties?.length > 0 && <p style={{ color:'#C9A227', fontSize:'11px', margin:'4px 0 0' }}>{Array.isArray(d.assigned_properties) ? d.assigned_properties.join(', ') : d.assigned_properties}</p>}
                      </div>
                      <span style={{ background: d.is_active ? '#1a3a1a' : '#2a1a1a', color: d.is_active ? '#4caf50' : '#f44336', padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold' }}>
                        {d.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {isCA && (
                      <div style={{ display:'flex', gap:'6px', marginTop:'8px' }}>
                        <button onClick={() => { setEditingDriver({...d, assigned_properties: Array.isArray(d.assigned_properties) ? d.assigned_properties : []}); setShowAddDriver(false); setDriverMsg('') }}
                          style={{ flex:1, padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          Edit
                        </button>
                        <button onClick={() => toggleDriverActive(d)}
                          style={{ flex:1, padding:'7px', background: d.is_active ? '#3a1a1a' : '#1a3a1a', color: d.is_active ? '#f44336' : '#4caf50', border:`1px solid ${d.is_active ? '#b71c1c' : '#2e7d32'}`, borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          {d.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {companyDrivers.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No drivers found</p></div>}
              </div>
            )}

            {/* SECTION 4 — Storage Facilities */}
            {manageSection === 'storage' && (
              <div>
                <div style={{ background:'#1a1e2e', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                  <p style={{ color:'#888', fontSize:'11px', margin:'0' }}>Storage facilities are shared across all companies.</p>
                </div>
                {facilityMsg && msgBox(facilityMsg)}
                {isCA && addBtn('+ Add Storage Facility', () => { setShowAddFacility(true); setFacilityMsg('') })}

                {showAddFacility && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Storage Facility</p>
                    <label style={lbl}>Facility Name *</label>
                    <input value={newFacility.name} onChange={e => setNewFacility({ ...newFacility, name: e.target.value })} placeholder="Houston Impound" style={inp} />
                    <label style={lbl}>Address *</label>
                    <input value={newFacility.address} onChange={e => setNewFacility({ ...newFacility, address: e.target.value })} placeholder="456 Storage Blvd, Houston TX" style={inp} />
                    <label style={lbl}>Phone</label>
                    <input value={newFacility.phone} onChange={e => setNewFacility({ ...newFacility, phone: e.target.value })} placeholder="(713) 555-0100" style={inp} />
                    <label style={lbl}>Email</label>
                    <input type="email" value={newFacility.email} onChange={e => setNewFacility({ ...newFacility, email: e.target.value })} placeholder="storage@example.com" style={inp} />
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={createFacility} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Add Facility</button>
                      <button onClick={() => { setShowAddFacility(false); setFacilityMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                {allFacilities.map((f, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'8px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{f.name}</p>
                        <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{f.address}</p>
                        {f.phone && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{f.phone}</p>}
                        {f.email && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{f.email}</p>}
                      </div>
                      <span style={{ background: f.is_active ? '#1a3a1a' : '#2a1a1a', color: f.is_active ? '#4caf50' : '#f44336', padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold' }}>
                        {f.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                ))}
                {allFacilities.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No storage facilities found</p></div>}
              </div>
            )}

            {/* SECTION 5 — Audit Log */}
            {manageSection === 'auditlog' && (() => {
              const actionColor: Record<string, { bg: string; color: string }> = {
                ADD_VIOLATION:        { bg:'#3a1a1a', color:'#f44336' },
                create_property:      { bg:'#1a2a3a', color:'#2196f3' },
                update_property:      { bg:'#1e2535', color:'#aaa' },
                activate_property:    { bg:'#1a3a1a', color:'#4caf50' },
                deactivate_property:  { bg:'#3a1a1a', color:'#f44336' },
                create_user:          { bg:'#1a2a3a', color:'#2196f3' },
                create_driver:        { bg:'#1a2a3a', color:'#2196f3' },
                activate_driver:      { bg:'#1a3a1a', color:'#4caf50' },
                deactivate_driver:    { bg:'#3a1a1a', color:'#f44336' },
                create_facility:      { bg:'#1a2a3a', color:'#2196f3' },
              }
              const today = new Date(); today.setHours(0,0,0,0)
              const week = new Date(); week.setDate(week.getDate()-7)
              const month = new Date(); month.setMonth(month.getMonth()-1)
              const filtered = companyAuditLogs.filter(log => {
                const d = new Date(log.created_at)
                const inPeriod = auditDateFilter === 'today' ? d >= today : auditDateFilter === 'week' ? d >= week : auditDateFilter === 'month' ? d >= month : true
                if (!inPeriod) return false
                if (!auditSearch) return true
                const q = auditSearch.toLowerCase()
                return (log.user_email || '').toLowerCase().includes(q) ||
                  (log.action || '').toLowerCase().includes(q) ||
                  JSON.stringify(log.new_values || {}).toLowerCase().includes(q)
              })
              return (
                <div>
                  <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'10px' }}>
                    {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'month',l:'Month'},{k:'all',l:'All'}].map(f => (
                      <button key={f.k} onClick={() => setAuditDateFilter(f.k)}
                        style={{ flex:1, padding:'7px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', background: auditDateFilter === f.k ? '#C9A227' : 'transparent', color: auditDateFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                        {f.l}
                      </button>
                    ))}
                  </div>
                  <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search email, action..." style={{ ...inp, marginBottom:'10px' }} />
                  {!auditLoaded ? (
                    <p style={{ color:'#555', fontSize:'13px', textAlign:'center', margin:'32px 0' }}>Loading...</p>
                  ) : filtered.length === 0 ? (
                    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                      <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No activity for this period</p>
                    </div>
                  ) : filtered.map((log, i) => {
                    const badge2 = actionColor[log.action] || { bg:'#1e2535', color:'#aaa' }
                    const vals = log.new_values ? Object.entries(log.new_values as Record<string,unknown>).map(([k,v]) => `${k}: ${v}`).join(' · ') : ''
                    return (
                      <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                          <span style={{ background:badge2.bg, color:badge2.color, padding:'2px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', letterSpacing:'0.04em' }}>{log.action}</span>
                          <span style={{ color:'#555', fontSize:'10px' }}>{new Date(log.created_at).toLocaleString()}</span>
                        </div>
                        <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>{log.user_email}</p>
                        {vals && <p style={{ color:'#555', fontSize:'11px', margin:'0', fontFamily:'Courier New', wordBreak:'break-all' }}>{vals}</p>}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>
        )}

        <div style={{ textAlign:'center', marginTop:'24px', paddingBottom:'20px' }}>
          <p style={{ color:'#2a2f3d', fontSize:'11px', margin:'0' }}>A1 Wrecker, LLC · Houston's #1 Towing & Recovery</p>
        </div>

      </div>

      {/* ── CAMERA MODAL ── */}
      {showCamera && (
        <div style={{ position:'fixed', inset:0, background:'#000', zIndex:9999, display:'flex', flexDirection:'column' }}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

          <div style={{ position:'relative', flex:1, overflow:'hidden' }}>
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width:'100%', height:'100%', objectFit:'cover' }} />

            <div style={{
              position:'absolute', top:'50%', left:'50%',
              transform:'translate(-50%, -50%)',
              width:'82%', maxWidth:'340px', height:'90px',
              border:'2px solid #C9A227', borderRadius:'8px',
              boxShadow:'0 0 0 9999px rgba(0,0,0,0.52)',
            }}>
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

          <div style={{ padding:'20px 20px 32px', background:'#0f1117' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', marginBottom:'6px', minHeight:'28px' }}>
              {scanning && (
                <div style={{ width:'18px', height:'18px', border:'2px solid #2a2f3d', borderTop:'2px solid #C9A227', borderRadius:'50%', animation:'spin 0.8s linear infinite', flexShrink:0 }} />
              )}
              <p style={{ color: scanning ? '#C9A227' : '#aaa', fontSize:'13px', margin:0, fontWeight: scanning ? 'bold' : 'normal' }}>
                {scanStatus}
              </p>
            </div>
            {!scanning && (
              <p style={{ color:'#444', fontSize:'11px', textAlign:'center', margin:'0 0 16px', lineHeight:'1.6' }}>
                For best results: good lighting, hold steady, plate fills the targeting box
              </p>
            )}
            {scanning && <div style={{ height:'28px' }} />}
            <div style={{ display:'flex', gap:'10px' }}>
              <button onClick={closeCamera} disabled={scanning}
                style={{ flex:1, padding:'14px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'10px', cursor: scanning ? 'not-allowed' : 'pointer', fontSize:'14px', fontFamily:'Arial' }}>
                Cancel
              </button>
              <button onClick={captureAndScan} disabled={scanning}
                style={{ flex:2, padding:'14px', background: scanning ? '#555' : '#C9A227', color: scanning ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'10px', cursor: scanning ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                {scanning ? 'Reading...' : '📷 Capture'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

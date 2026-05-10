'use client'
import { useState, useEffect } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { supabase } from '../supabase'
import { logAudit } from '../lib/audit'
import SupportContact from '../components/SupportContact'
import { getCachedLogoUrl, getPlatformLogoUrl } from '../lib/logo'
import { normalizePlate } from '../lib/plate'
import { BarChart, Bar, LineChart, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function ManagerPortal() {
  const [manager, setManager] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [vehicles, setVehicles] = useState<any[]>([])
  const [violations, setViolations] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  const [residents, setResidents] = useState<any[]>([])
  const [stats, setStats] = useState({ total_vehicles: 0, active_passes: 0, violations_today: 0, violations_week: 0 })
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [newVehicle, setNewVehicle] = useState({ plate: '', state: 'TX', make: '', model: '', year: '', color: '', unit: '', space: '', permit_expiry: '' })
  const [violationFilter, setViolationFilter] = useState('today')
  const [showAddResident, setShowAddResident] = useState(false)
  const [newResident, setNewResident] = useState({ name: '', email: '', phone: '', unit: '', space: '', lease_end: '' })
  const [editingResident, setEditingResident] = useState<any>(null)
  const [allProperties, setAllProperties] = useState<any[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [isReadOnly, setIsReadOnly] = useState(false)
  const [spaces, setSpaces] = useState<any[]>([])
  const [editingSpace, setEditingSpace] = useState<any>(null)
  const [spaceError, setSpaceError] = useState('')
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null)
  const [vehicleSearch, setVehicleSearch] = useState('')
  const [residentSearch, setResidentSearch] = useState('')
  const [violationSearch, setViolationSearch] = useState('')
  const [pendingVehicles, setPendingVehicles] = useState<any[]>([])
  const [pendingNotes, setPendingNotes] = useState<Record<string, string>>({})
  const [unitNotes, setUnitNotes] = useState<Record<string, string>>({})
  const [passLimit, setPassLimit] = useState('')
  const [exemptPlates, setExemptPlates] = useState<string[]>([])
  const [newExemptPlate, setNewExemptPlate] = useState('')
  const [settingsMsg, setSettingsMsg] = useState('')
  const [auditLogs, setAuditLogs] = useState<any[]>([])
  const [auditDateFilter, setAuditDateFilter] = useState('week')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)
  const [pendingResidents, setPendingResidents] = useState<any[]>([])
  const [residentNotes, setResidentNotes] = useState<Record<string, string>>({})
  const [managerCompany, setManagerCompany] = useState('')
  const [resetPwTarget, setResetPwTarget] = useState<string | null>(null)
  const [resetPwForm, setResetPwForm] = useState({ newPw: '', confirmPw: '' })
  const [resetPwMsg, setResetPwMsg] = useState('')
  const [plateQuery, setPlateQuery] = useState('')
  const [plateSuggestions, setPlateSuggestions] = useState<any[]>([])
  const [plateMsg, setPlateMsg] = useState<{ text: string; type: 'error' | 'warning' } | null>(null)
  const [showActiveResidents, setShowActiveResidents] = useState(true)
  const [showActiveVehicles, setShowActiveVehicles] = useState(true)
  const [disputes, setDisputes] = useState<any[]>([])
  const [pendingDisputeCount, setPendingDisputeCount] = useState(0)
  const [disputeNotes, setDisputeNotes] = useState<Record<string, string>>({})
  const [insightsLoaded, setInsightsLoaded] = useState(false)
  const [mgAnalytics, setMgAnalytics] = useState<any>(null)

  useEffect(() => { loadManager(); getPlatformLogoUrl() }, [])
  useEffect(() => { if (activeTab === 'activity' && manager) fetchActivityLogs() }, [activeTab, manager])
  useEffect(() => { if (activeTab === 'disputes' && manager) fetchDisputes(manager.name) }, [activeTab, manager])
  useEffect(() => { if (activeTab === 'insights' && manager) fetchInsights() }, [activeTab, manager])
  useEffect(() => {
    if (editingSpace) {
      setPlateQuery(editingSpace.assigned_to_plate || '')
    } else {
      setPlateQuery('')
    }
    setPlateSuggestions([])
    setPlateMsg(null)
  }, [editingSpace?.id])
  useEffect(() => {
    if (manager) {
      setPassLimit(manager.visitor_pass_limit != null ? String(manager.visitor_pass_limit) : '')
      setExemptPlates(manager.exempt_plates || [])
    }
  }, [manager])

  async function loadManager() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('*')
      .ilike('email', user.email!)
      .single()

    if (!roleData) {
      setError('No role assigned. Contact your administrator.')
      setLoading(false)
      return
    }

    if (roleData.role === 'admin') {
      setIsAdmin(true)
      const { data: props } = await supabase.from('properties').select('*').order('name')
      setAllProperties(props || [])
      if (props && props.length > 0) {
        setManager(props[0])
        fetchAll(props[0].name)
      }
      setLoading(false)
    } else if (roleData.role === 'manager' || roleData.role === 'leasing_agent') {
      if (roleData.role === 'leasing_agent') setIsReadOnly(true)
      setManagerCompany(roleData.company || '')
      const { data, error } = await supabase
        .from('properties')
        .select('*')
        .ilike('name', roleData.property)
      setLoading(false)
      if (error || !data || data.length === 0) {
        setError(`No property found matching "${roleData.property}". Check your user_roles table.`)
      } else {
        setManager(data[0])
        fetchAll(data[0].name)
      }
    } else {
      setError('You do not have manager access.')
      setLoading(false)
    }
  }

  async function switchProperty(name: string) {
    const prop = allProperties.find(p => p.name === name)
    if (prop) { setManager(prop); fetchAll(prop.name) }
  }

  async function fetchAll(property: string) {
    fetchVehicles(property)
    fetchViolations(property)
    fetchPasses(property)
    fetchResidents(property)
    fetchSpaces(property)
    fetchDisputes(property)
  }

  async function fetchDisputes(property: string) {
    const { data } = await supabase.from('dispute_requests').select('*').ilike('property', property).order('created_at', { ascending: false })
    setDisputes(data || [])
    setPendingDisputeCount((data || []).filter((d: any) => d.status === 'pending').length)
  }

  async function upholdDispute(d: any) {
    await supabase.from('dispute_requests').update({ status: 'upheld', pm_decision: 'upheld', pm_note: disputeNotes[d.id] || null, resolved_at: new Date().toISOString() }).eq('id', d.id)
    await logAudit({ action: 'DISPUTE_UPHELD', table_name: 'dispute_requests', record_id: d.id, new_values: { status: 'upheld', pm_note: disputeNotes[d.id] } })
    fetchDisputes(manager.name)
  }

  async function resolveDispute(d: any) {
    await supabase.from('dispute_requests').update({ status: 'resolved', pm_decision: 'resolved', pm_note: disputeNotes[d.id] || null, resolved_at: new Date().toISOString() }).eq('id', d.id)
    await logAudit({ action: 'DISPUTE_RESOLVED', table_name: 'dispute_requests', record_id: d.id, new_values: { status: 'resolved', pm_note: disputeNotes[d.id] } })
    fetchDisputes(manager.name)
  }

  async function savePassLimit() {
    const val = passLimit === '' ? null : parseInt(passLimit)
    const { error } = await supabase.from('properties').update({ visitor_pass_limit: val }).eq('id', manager.id)
    if (error) { setSettingsMsg('Error: ' + error.message) }
    else {
      await logAudit({ action: 'SET_PASS_LIMIT', table_name: 'properties', record_id: manager.id, new_values: { visitor_pass_limit: val, property: manager.name } })
      setSettingsMsg('Pass limit saved.'); setManager({ ...manager, visitor_pass_limit: val })
    }
  }

  async function addExemptPlate() {
    const plate = normalizePlate(newExemptPlate)
    if (!plate || exemptPlates.includes(plate)) { setNewExemptPlate(''); return }
    const updated = [...exemptPlates, plate]
    const { error } = await supabase.from('properties').update({ exempt_plates: updated }).eq('id', manager.id)
    if (error) { setSettingsMsg('Error: ' + error.message) }
    else {
      await logAudit({ action: 'ADD_EXEMPT_PLATE', table_name: 'properties', record_id: manager.id, new_values: { plate, property: manager.name } })
      setExemptPlates(updated); setManager({ ...manager, exempt_plates: updated }); setNewExemptPlate(''); setSettingsMsg('')
    }
  }

  async function removeExemptPlate(plate: string) {
    const updated = exemptPlates.filter(p => p !== plate)
    const { error } = await supabase.from('properties').update({ exempt_plates: updated }).eq('id', manager.id)
    if (error) { setSettingsMsg('Error: ' + error.message) }
    else {
      await logAudit({ action: 'REMOVE_EXEMPT_PLATE', table_name: 'properties', record_id: manager.id, new_values: { plate, property: manager.name } })
      setExemptPlates(updated); setManager({ ...manager, exempt_plates: updated })
    }
  }

  async function fetchSpaces(property: string) {
    const { data } = await supabase.from('spaces').select('*').ilike('property', property).order('space_number')
    setSpaces(data || [])
  }

  async function handlePlateSearch(query: string) {
    setPlateQuery(query)
    setEditingSpace({ ...editingSpace, assigned_to_plate: query })
    setPlateMsg(null)
    setPlateSuggestions([])
    if (query.length < 2) return
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .ilike('property', manager.name)
      .ilike('plate', `%${query}%`)
      .in('status', ['active', 'pending'])
      .limit(8)
    const results = data || []
    setPlateSuggestions(results)
    if (results.length === 0 && query.length >= 3) {
      setPlateMsg({ text: 'This plate is not registered. Please add the vehicle first before assigning a space.', type: 'warning' })
    }
  }

  function selectPlate(plate: string) {
    const conflict = spaces.find(s =>
      s.id !== editingSpace.id &&
      s.status === 'occupied' &&
      s.assigned_to_plate?.toLowerCase() === plate.toLowerCase()
    )
    if (conflict) {
      setPlateMsg({ text: `This plate is already assigned to Space ${conflict.space_number}. Release that space first or choose a different plate.`, type: 'error' })
      setPlateSuggestions([])
      setPlateQuery(plate)
      setEditingSpace({ ...editingSpace, assigned_to_plate: plate })
      return
    }
    setEditingSpace({ ...editingSpace, assigned_to_plate: plate })
    setPlateQuery(plate)
    setPlateSuggestions([])
    setPlateMsg(null)
  }

  async function saveSpace() {
    if (!editingSpace) return
    setSpaceError('')

    const isOccupied = editingSpace.status === 'occupied'
    const isReleasing = editingSpace.status === 'available'

    if (isOccupied && editingSpace.assigned_to_plate) {
      const conflict = spaces.find(s =>
        s.id !== editingSpace.id &&
        s.status === 'occupied' &&
        s.assigned_to_plate?.toLowerCase() === editingSpace.assigned_to_plate?.toLowerCase()
      )
      if (conflict) {
        setSpaceError(`Space ${conflict.space_number} is already assigned to ${conflict.assigned_to_unit || '—'} - ${conflict.assigned_to_plate}`)
        return
      }
    }

    const updates: any = {
      status: editingSpace.status,
      notes: editingSpace.notes ?? '',
      location_notes: editingSpace.location_notes || null,
      assigned_to_unit: isReleasing ? null : editingSpace.assigned_to_unit,
      assigned_to_plate: isReleasing ? null : editingSpace.assigned_to_plate,
    }

    const { error } = await supabase.from('spaces').update(updates).eq('id', editingSpace.id)
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'EDIT_SPACE', table_name: 'spaces', record_id: editingSpace.id, new_values: { space_number: editingSpace.space_number, status: editingSpace.status, assigned_to_unit: editingSpace.assigned_to_unit, assigned_to_plate: editingSpace.assigned_to_plate, property: manager.name } })
      setEditingSpace(null); fetchSpaces(manager.name)
    }
  }

  async function fetchVehicles(property: string) {
    const { data } = await supabase.from('vehicles').select('*').ilike('property', property).order('unit')
    const all = data || []
    const pending = all.filter(v => v.status === 'pending')
    const rest = all.filter(v => v.status !== 'pending')
    setPendingVehicles(pending)
    setVehicles(rest)
    setStats(s => ({ ...s, total_vehicles: rest.length }))
  }

  async function approveVehicle(id: string) {
    await supabase.from('vehicles').update({ is_active: true, status: 'active', manager_note: pendingNotes[id] || null, resident_read: true }).eq('id', id)
    await logAudit({ action: 'APPROVE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { status: 'active', property: manager.name } })
    setPendingNotes(n => { const c = {...n}; delete c[id]; return c })
    fetchVehicles(manager.name)
  }

  async function declineVehicle(id: string) {
    await supabase.from('vehicles').update({ is_active: false, status: 'declined', manager_note: pendingNotes[id] || null }).eq('id', id)
    await logAudit({ action: 'DECLINE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { status: 'declined', property: manager.name } })
    const { data: veh } = await supabase.from('vehicles').select('unit, property').eq('id', id).single()
    if (veh) {
      await supabase.from('residents')
        .update({ status: 'active', is_active: true })
        .ilike('unit', veh.unit)
        .ilike('property', veh.property)
        .eq('status', 'pending')
    }
    setPendingNotes(n => { const c = {...n}; delete c[id]; return c })
    fetchVehicles(manager.name)
  }

  async function approveAllForUnit(unitVehicles: any[], unit: string) {
    const note = unitNotes[unit] || null
    await Promise.all(unitVehicles.map(v =>
      supabase.from('vehicles').update({ is_active: true, status: 'active', manager_note: note, resident_read: true }).eq('id', v.id)
        .then(() => logAudit({ action: 'APPROVE_VEHICLE', table_name: 'vehicles', record_id: v.id, new_values: { status: 'active', property: manager.name } }))
    ))
    setUnitNotes(n => { const c = {...n}; delete c[unit]; return c })
    fetchVehicles(manager.name)
  }

  async function declineAllForUnit(unitVehicles: any[], unit: string) {
    const note = unitNotes[unit] || null
    await Promise.all(unitVehicles.map(v =>
      supabase.from('vehicles').update({ is_active: false, status: 'declined', manager_note: note }).eq('id', v.id)
        .then(() => logAudit({ action: 'DECLINE_VEHICLE', table_name: 'vehicles', record_id: v.id, new_values: { status: 'declined', property: manager.name } }))
    ))
    await supabase.from('residents')
      .update({ status: 'active', is_active: true })
      .ilike('unit', unit)
      .ilike('property', manager.name)
      .eq('status', 'pending')
    setUnitNotes(n => { const c = {...n}; delete c[unit]; return c })
    fetchVehicles(manager.name)
  }

  async function fetchViolations(property: string) {
    const week = new Date(); week.setDate(week.getDate() - 7)
    const { data } = await supabase.from('violations').select('*').ilike('property', property).gte('created_at', week.toISOString()).order('created_at', { ascending: false })
    setViolations(data || [])
    const today = new Date(); today.setHours(0,0,0,0)
    const todayCount = (data || []).filter(v => new Date(v.created_at) >= today).length
    setStats(s => ({ ...s, violations_today: todayCount, violations_week: data?.length || 0 }))
  }

  async function fetchPasses(property: string) {
    const now = new Date().toISOString()
    const { data } = await supabase
      .from('visitor_passes')
      .select('*')
      .ilike('property', property)
      .gte('expires_at', now)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    setPasses(data || [])
    setStats(s => ({ ...s, active_passes: data?.length || 0 }))
  }

  async function fetchResidents(property: string) {
    const { data } = await supabase.from('residents').select('*').ilike('property', property).order('unit')
    const all = data || []
    setPendingResidents(all.filter(r => r.status === 'pending'))
    setResidents(all.filter(r => r.status !== 'pending'))
  }

  async function resetResidentPassword() {
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

  async function approveResident(r: any) {
    const note = residentNotes[r.id] || null
    await supabase.from('residents').update({ is_active: true, status: 'active', manager_note: note }).eq('id', r.id)
    await supabase.from('vehicles').update({ is_active: true, status: 'active' }).ilike('unit', r.unit).ilike('property', manager.name).eq('status', 'pending')
    await logAudit({ action: 'APPROVE_RESIDENT', table_name: 'residents', record_id: r.id, new_values: { name: r.name, unit: r.unit, property: manager.name } })
    setResidentNotes(n => { const c = {...n}; delete c[r.id]; return c })
    fetchResidents(manager.name)
  }

  async function declineResident(r: any) {
    const note = residentNotes[r.id] || null
    await supabase.from('residents').update({ is_active: false, status: 'declined', manager_note: note }).eq('id', r.id)
    await supabase.from('vehicles').update({ is_active: false, status: 'declined' }).ilike('unit', r.unit).ilike('property', manager.name).eq('status', 'pending')
    await logAudit({ action: 'DECLINE_RESIDENT', table_name: 'residents', record_id: r.id, new_values: { name: r.name, unit: r.unit, property: manager.name } })
    setResidentNotes(n => { const c = {...n}; delete c[r.id]; return c })
    fetchResidents(manager.name)
  }

  async function addVehicle(unit?: string) {
    if (!newVehicle.plate) { alert('Plate is required'); return }
    const normalizedPlate = normalizePlate(newVehicle.plate)
    const { error } = await supabase.from('vehicles').insert([{
      ...newVehicle,
      plate: normalizedPlate,
      unit: unit || newVehicle.unit,
      property: manager.name,
      is_active: true,
      year: parseInt(newVehicle.year) || null
    }])
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'ADD_VEHICLE', table_name: 'vehicles', new_values: { plate: normalizedPlate, make: newVehicle.make, model: newVehicle.model, unit: unit || newVehicle.unit, property: manager.name } })
      alert('Vehicle added!')
      setShowAddVehicle(false)
      setNewVehicle({ plate:'', state:'TX', make:'', model:'', year:'', color:'', unit:'', space:'', permit_expiry:'' })
      fetchVehicles(manager.name)
    }
  }

  async function removeVehicle(id: string) {
    if (!confirm('Remove this vehicle?')) return
    await supabase.from('vehicles').update({ is_active: false }).eq('id', id)
    await logAudit({ action: 'REMOVE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { is_active: false, property: manager.name } })
    fetchVehicles(manager.name)
  }

  async function addResident() {
    if (!newResident.name || !newResident.unit || !newResident.email) { alert('Name, email and unit are required'); return }
    const { error } = await supabase.from('residents').insert([{ ...newResident, property: manager.name, is_active: true }])
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'ADD_RESIDENT', table_name: 'residents', new_values: { name: newResident.name, email: newResident.email, unit: newResident.unit, property: manager.name } })
      alert('Resident added!')
      setShowAddResident(false)
      setNewResident({ name:'', email:'', phone:'', unit:'', space:'', lease_end:'' })
      fetchResidents(manager.name)
    }
  }

  async function saveResident() {
    const { error } = await supabase.from('residents').update({
      name: editingResident.name,
      email: editingResident.email,
      phone: editingResident.phone,
      unit: editingResident.unit,
      space: editingResident.space,
      lease_end: editingResident.lease_end,
    }).eq('id', editingResident.id)
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'EDIT_RESIDENT', table_name: 'residents', record_id: editingResident.id, new_values: { name: editingResident.name, email: editingResident.email, unit: editingResident.unit, property: manager.name } })
      alert('Resident updated!'); setEditingResident(null); fetchResidents(manager.name)
    }
  }

  async function deactivateResident(id: string) {
    if (!confirm('Deactivate this resident?')) return
    await supabase.from('residents').update({ is_active: false }).eq('id', id)
    await logAudit({ action: 'DEACTIVATE_RESIDENT', table_name: 'residents', record_id: id, new_values: { is_active: false, property: manager.name } })
    fetchResidents(manager.name)
  }

  async function fetchActivityLogs() {
    if (!manager) return
    setAuditLoaded(false)
    const { data } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    const propName = manager.name.toLowerCase()
    const filtered = (data || []).filter(log =>
      JSON.stringify(log.new_values || {}).toLowerCase().includes(propName) ||
      JSON.stringify(log.old_values || {}).toLowerCase().includes(propName) ||
      (log.notes || '').toLowerCase().includes(propName)
    )
    setAuditLogs(filtered)
    setAuditLoaded(true)
  }

  function filteredVehicles() {
    let list = vehicles
    if (showActiveVehicles) list = list.filter(v => v.is_active)
    if (!vehicleSearch) return list
    const q = vehicleSearch.toLowerCase()
    const qPlate = normalizePlate(vehicleSearch)
    return list.filter(v =>
      (qPlate && normalizePlate(v.plate).includes(qPlate)) ||
      v.unit?.toLowerCase().includes(q) ||
      v.make?.toLowerCase().includes(q) ||
      v.model?.toLowerCase().includes(q) ||
      v.color?.toLowerCase().includes(q)
    )
  }

  function filteredResidents() {
    let list = residents
    if (showActiveResidents) list = list.filter(r => r.is_active)
    if (!residentSearch) return list
    const q = residentSearch.toLowerCase()
    return list.filter(r =>
      r.name?.toLowerCase().includes(q) ||
      r.email?.toLowerCase().includes(q) ||
      r.unit?.toLowerCase().includes(q) ||
      r.phone?.toLowerCase().includes(q)
    )
  }

  function filteredViolations() {
    const today = new Date(); today.setHours(0,0,0,0)
    const week = new Date(); week.setDate(week.getDate()-7)
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth()-6)
    return violations.filter(v => {
      const d = new Date(v.created_at)
      const inPeriod = violationFilter === 'today' ? d >= today : violationFilter === 'week' ? d >= week : d >= sixmo
      if (!inPeriod) return false
      if (!violationSearch) return true
      const q = violationSearch.toLowerCase()
      const qPlate = normalizePlate(violationSearch)
      return (qPlate && normalizePlate(v.plate).includes(qPlate)) || v.violation_type?.toLowerCase().includes(q) || v.location?.toLowerCase().includes(q)
    })
  }

  function reprintTicket(v: any) {
    const tw = window.open('', '_blank')
    if (!tw) return
    const total = parseFloat(v.tow_fee || '0').toFixed(2)
    const photosHtml = v.photos?.length
      ? `<div style="margin-top:20px"><p style="font-weight:bold;margin-bottom:8px">EVIDENCE PHOTOS</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${v.photos.map((u: string) => `<img src="${u}" style="width:100%;border-radius:4px;border:1px solid #ddd" onerror="this.style.display='none'">`).join('')}</div></div>`
      : ''
    tw.document.write(`<!DOCTYPE html><html><head><title>Tow Ticket — ${v.plate}</title><style>
      *{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;padding:28px;max-width:680px;margin:0 auto;color:#111;font-size:13px}
      .hdr{display:flex;align-items:center;gap:14px;margin-bottom:22px;padding-bottom:14px;border-bottom:3px solid #C9A227}
      .logo{width:64px;height:64px;border-radius:8px;border:2px solid #C9A227;object-fit:contain}
      .sec{margin-bottom:18px}.sh{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:8px;padding-bottom:3px;border-bottom:1px solid #eee}
      .g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.f label{font-size:10px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.05em;display:block}
      .f span{font-size:13px;color:#111;display:block;margin-top:1px}.plate{font-family:"Courier New",monospace;font-size:22px;font-weight:bold}
      .warn{background:#fff3cd;border:1px solid #e6b800;border-radius:5px;padding:9px 12px;font-size:11px;margin-bottom:16px}
      .sig-wrap{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:28px}.sig-line{border-top:1px solid #555;padding-top:5px;font-size:10px;color:#666;margin-top:36px}
      .ftr{margin-top:20px;padding-top:10px;border-top:2px solid #C9A227;font-size:10px;color:#888;text-align:center}
      @media print{.no-print{display:none}body{padding:18px}}
    </style></head><body>
      <div class="hdr">
        <img src="${getCachedLogoUrl(localStorage.getItem('company_logo'))}" class="logo" alt="" onerror="this.style.display='none'">
        <div>
          <div style="font-size:20px;font-weight:bold">${managerCompany || 'Tow Service'}</div>
          <div style="font-size:15px;font-weight:bold;color:#C9A227;margin-top:3px">OFFICIAL TOW TICKET (REPRINT)</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:10px;color:#888">Date / Time</div>
          <div style="font-weight:bold">${new Date(v.created_at).toLocaleString()}</div>
          <div style="font-size:10px;color:#888;margin-top:4px">Ticket #</div>
          <div style="font-weight:bold">${String(v.id).substring(0,8).toUpperCase()}</div>
        </div>
      </div>
      <div class="warn">⚠ This vehicle has been towed pursuant to Texas Transportation Code §683. Contact the storage facility below to recover your vehicle.</div>
      <div class="sec"><div class="sh">Vehicle Information</div><div class="g2">
        <div class="f"><label>License Plate</label><span class="plate">${v.plate}</span></div>
        <div class="f"><label>State</label><span>${v.state || '—'}</span></div>
        <div class="f"><label>Year / Make / Model</label><span>${[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}</span></div>
        <div class="f"><label>Color</label><span>${v.color || '—'}</span></div>
        <div class="f"><label>VIN</label><span>${v.vin || '—'}</span></div>
        ${v.vehicle_color || v.vehicle_make || v.vehicle_model ? `<div class="f" style="grid-column:span 2"><label>Color / Make / Model (at scene)</label><span>${[v.vehicle_color, v.vehicle_make, v.vehicle_model].filter(Boolean).join('  ·  ')}</span></div>` : ''}
      </div></div>
      <div class="sec"><div class="sh">Violation</div><div class="g2">
        <div class="f"><label>Type</label><span>${v.violation_type || '—'}</span></div>
        <div class="f"><label>Location / Space</label><span>${v.location || '—'}</span></div>
        <div class="f" style="grid-column:span 2"><label>Notes</label><span>${v.notes || 'No additional notes.'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Property</div><div class="g2">
        <div class="f"><label>Authorized By</label><span>${v.property || '—'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Tow Operator</div><div class="g2">
        <div class="f"><label>Name</label><span>${v.driver_name || '—'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Storage / Impound</div><div class="g2">
        <div class="f"><label>Facility</label><span>${v.tow_storage_name || '—'}</span></div>
        <div class="f"><label>Phone</label><span>${v.tow_storage_phone || '—'}</span></div>
        <div class="f" style="grid-column:span 2"><label>Address</label><span>${v.tow_storage_address || '—'}</span></div>
      </div></div>
      ${parseFloat(v.tow_fee || '0') > 0 ? `<div class="sec"><div class="sh">Fees</div><div class="g2">
        <div class="f"><label>Tow Fee</label><span>$${parseFloat(v.tow_fee).toFixed(2)}</span></div>
        <div class="f"><label>Total Due</label><span style="font-size:16px;font-weight:bold">$${total}</span></div>
      </div></div>` : ''}
      ${photosHtml}
      <div class="sig-wrap"><div><div class="sig-line">Operator Signature</div></div><div><div class="sig-line">Date</div></div></div>
      <div class="ftr">${managerCompany || ''}<br>Reprinted ${new Date().toLocaleString()}</div>
      <div class="no-print" style="margin-top:20px;display:flex;gap:10px;justify-content:center">
        <button onclick="window.print()" style="padding:11px 22px;background:#C9A227;color:#0f1117;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Print Ticket</button>
        <button onclick="window.close()" style="padding:11px 22px;background:#333;color:#fff;font-size:13px;border:none;border-radius:7px;cursor:pointer">Close</button>
      </div>
    </body></html>`)
    tw.document.close()
  }

  async function fetchInsights() {
    if (!manager) return
    setInsightsLoaded(false)
    const now = new Date()
    const sixMoAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1)
    const mk = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`

    const [{ data: vData }, { data: vehData }, { data: drData }] = await Promise.all([
      supabase.from('violations').select('created_at,tow_ticket_generated').ilike('property', manager.name).gte('created_at', sixMoAgo.toISOString()),
      supabase.from('vehicles').select('status,is_active').ilike('property', manager.name),
      supabase.from('dispute_requests').select('id').ilike('property', manager.name).gte('created_at', sixMoAgo.toISOString()),
    ])
    const viols = vData || []

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const byDay = Array(7).fill(0)
    const byHour = Array(24).fill(0)
    viols.forEach((v: any) => { const d = new Date(v.created_at); byDay[d.getDay()]++; byHour[d.getHours()]++ })

    const monthLabels: { label: string; key: string }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      monthLabels.push({ label: d.toLocaleString('en-US', { month: 'short' }), key: mk(d) })
    }
    const byMonth: Record<string, number> = {}
    viols.forEach((v: any) => { const k = mk(new Date(v.created_at)); byMonth[k] = (byMonth[k] || 0) + 1 })

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const thisMonthCount = viols.filter((v: any) => new Date(v.created_at) >= thisMonthStart).length
    const lastMonthCount = viols.filter((v: any) => { const d = new Date(v.created_at); return d >= lastMonthStart && d < thisMonthStart }).length

    const vehs = vehData || []
    const complianceRate = vehs.length > 0 ? Math.round((vehs.filter((v: any) => v.is_active).length / vehs.length) * 100) : 100
    const disputeRate = viols.length > 0 ? Math.round(((drData?.length || 0) / viols.length) * 100) : 0

    const peakDayIdx = byDay.indexOf(Math.max(...byDay))
    const peakHourIdx = byHour.indexOf(Math.max(...byHour))
    const fmtH = (h: number) => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
    const insight = viols.length > 0 && byDay[peakDayIdx] > 0
      ? `Peak enforcement: ${dayNames[peakDayIdx]}s around ${fmtH(peakHourIdx)}. Schedule driver patrols during these hours.`
      : 'Not enough data yet to identify peak enforcement times.'

    setMgAnalytics({
      dayChartData: dayNames.map((name, i) => ({ name, count: byDay[i] })),
      monthData: monthLabels.map(m => ({ month: m.label, count: byMonth[m.key] || 0 })),
      byHour, thisMonthCount, lastMonthCount, complianceRate, disputeRate, insight,
    })
    setInsightsLoaded(true)
  }

  const tabStyle = (tab: string) => ({
    padding:'8px 10px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold' as const, fontSize:'11px',
    background: activeTab === tab ? '#C9A227' : '#1e2535',
    color: activeTab === tab ? '#0f1117' : '#888',
    fontFamily:'Arial, sans-serif', whiteSpace:'nowrap' as const
  })

  const inputStyle: React.CSSProperties = {
    display:'block', width:'100%', marginTop:'6px', marginBottom:'10px',
    padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055',
    borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box'
  }

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )

  if (error) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ textAlign:'center' }}>
        <p style={{ color:'#f44336', fontSize:'14px', marginBottom:'16px' }}>{error}</p>
        <a href="/login" style={{ color:'#C9A227', fontSize:'13px' }}>← Back to Login</a>
      </div>
    </main>
  )

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'600px', margin:'0 auto' }}>

        <div style={{ marginBottom:'16px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>{managerCompany || 'ShieldMyLot'}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Property Manager Portal</p>
        </div>

        {isAdmin && allProperties.length > 1 && (
          <div style={{ marginBottom:'12px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Viewing Property</label>
            <select onChange={e => switchProperty(e.target.value)} style={{ ...inputStyle, marginTop:'6px', fontSize:'13px' }}>
              {allProperties.map((p,i) => <option key={i} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px 16px', marginBottom:'14px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'15px', margin:'0' }}>{manager?.name}</p>
              <p style={{ color:'#aaa', fontSize:'12px', margin:'4px 0 0' }}>{manager?.address || ''} · {manager?.pm_name || ''}</p>
            </div>
            <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
              style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
              Sign Out
            </button>
          </div>
        </div>

        {isReadOnly && (
          <div style={{ background:'#1a1a2a', border:'1px solid #3a4055', borderRadius:'8px', padding:'10px 14px', marginBottom:'14px', display:'flex', alignItems:'center', gap:'8px' }}>
            <span style={{ color:'#C9A227', fontSize:'13px' }}>⚠</span>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'0' }}>Read-Only Access — Contact your Property Manager to make changes.</p>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'8px', marginBottom:'14px' }}>
          {[
            { label:'Vehicles', value: stats.total_vehicles, color:'#C9A227' },
            { label:'Today', value: stats.violations_today, color:'#f44336' },
            { label:'This Week', value: stats.violations_week, color:'#ff9800' },
            { label:'Visitors', value: stats.active_passes, color:'#4caf50' },
          ].map((s,i) => (
            <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', textAlign:'center' }}>
              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0' }}>{s.label}</p>
              <p style={{ color:s.color, fontSize:'24px', fontWeight:'bold', margin:'4px 0 0', fontFamily:'Courier New' }}>{s.value}</p>
            </div>
          ))}
        </div>

        <div style={{ display:'flex', flexWrap:'wrap', gap:'6px', background:'#1e2535', borderRadius:'8px', padding:'6px', marginBottom:'16px' }}>
          <button style={tabStyle('overview')} onClick={() => setActiveTab('overview')}>Overview</button>
          <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>
            Vehicles{pendingVehicles.length > 0 && <span style={{ background:'#B71C1C', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{pendingVehicles.length}</span>}
          </button>
          <button style={tabStyle('spaces')} onClick={() => setActiveTab('spaces')}>Spaces</button>
          <button style={tabStyle('residents')} onClick={() => setActiveTab('residents')}>
            Residents{pendingResidents.length > 0 && <span style={{ background:'#a16207', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{pendingResidents.length}</span>}
          </button>
          <button style={tabStyle('violations')} onClick={() => setActiveTab('violations')}>Violations</button>
          <button style={tabStyle('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
          <button style={tabStyle('settings')} onClick={() => setActiveTab('settings')}>Settings</button>
          <button style={tabStyle('disputes')} onClick={() => setActiveTab('disputes')}>
            Disputes{pendingDisputeCount > 0 && <span style={{ background:'#B71C1C', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{pendingDisputeCount}</span>}
          </button>
          <button style={tabStyle('insights')} onClick={() => setActiveTab('insights')}>Insights</button>
          <button style={tabStyle('activity')} onClick={() => setActiveTab('activity')}>Activity</button>
        </div>

        {/* OVERVIEW */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Recent Violations</p>
              {violations.slice(0,3).length === 0 ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No recent violations</p>
              : violations.slice(0,3).map((v,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                  <span style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{v.violation_type}</span>
                  <span style={{ color:'#555', fontSize:'11px' }}>{new Date(v.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Active Visitor Passes</p>
              {passes.length === 0 ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No active visitor passes</p>
              : passes.map((p,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                  <span style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{p.plate}</span>
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{p.visiting_unit}</span>
                  <span style={{ color:'#4caf50', fontSize:'11px' }}>Expires {new Date(p.expires_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* VEHICLES */}
        {activeTab === 'vehicles' && (
          <div>
            {pendingVehicles.length > 0 && (() => {
              const grouped = pendingVehicles.reduce((acc, v) => {
                const key = v.unit || 'Unknown Unit'
                if (!acc[key]) acc[key] = []
                acc[key].push(v)
                return acc
              }, {} as Record<string, any[]>)
              return (
                <div style={{ marginBottom:'16px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px' }}>
                    Pending Vehicle Requests ({pendingVehicles.length})
                  </p>
                  {(Object.entries(grouped) as [string, any[]][]).map(([unit, unitVehicles]) => {
                    const resident = residents.find((r: any) => r.unit?.toLowerCase() === unit.toLowerCase())
                    return (
                      <div key={unit} style={{ marginBottom:'16px' }}>
                        <div style={{ background:'#1a1500', border:'1px solid #C9A227', borderRadius:'8px', padding:'8px 12px', marginBottom:'8px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: !isReadOnly ? '8px' : '0' }}>
                            <div>
                              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0' }}>
                                Unit {unit} — {unitVehicles.length} vehicle{unitVehicles.length !== 1 ? 's' : ''} pending
                              </p>
                              {resident && <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{resident.name}</p>}
                            </div>
                            {!isReadOnly && (
                              <div style={{ display:'flex', gap:'6px' }}>
                                <button onClick={() => approveAllForUnit(unitVehicles, unit)}
                                  style={{ padding:'5px 10px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                                  Approve All
                                </button>
                                <button onClick={() => declineAllForUnit(unitVehicles, unit)}
                                  style={{ padding:'5px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                                  Decline All
                                </button>
                              </div>
                            )}
                          </div>
                          {!isReadOnly && (
                            <input
                              value={unitNotes[unit] || ''}
                              onChange={e => setUnitNotes(n => ({...n, [unit]: e.target.value}))}
                              placeholder="Shared note for all vehicles in this unit (optional)"
                              style={{ ...inputStyle, marginTop:'0', marginBottom:'0' }}
                            />
                          )}
                        </div>
                        {unitVehicles.map((v: any) => (
                          <div key={v.id} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px', marginLeft:'12px' }}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                              <div>
                                <p style={{ color:'white', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                                <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{[v.color, v.make, v.model, v.year].filter(Boolean).join(' ') || '—'}</p>
                              </div>
                              <span style={{ background:'#2a1e00', color:'#C9A227', border:'1px solid #C9A227', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold' }}>Pending</span>
                            </div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                              <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                              <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state || '—'}</span></div>
                            </div>
                            <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Note for resident (optional)</label>
                            <input
                              value={pendingNotes[v.id] || ''}
                              onChange={e => setPendingNotes(n => ({...n, [v.id]: e.target.value}))}
                              placeholder="e.g. Welcome! or Plate already registered."
                              style={{ ...inputStyle, marginTop:'4px', marginBottom:'10px' }}
                            />
                            {!isReadOnly && (
                              <div style={{ display:'flex', gap:'8px' }}>
                                <button onClick={() => approveVehicle(v.id)}
                                  style={{ flex:1, padding:'8px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                                  Approve
                                </button>
                                <button onClick={() => declineVehicle(v.id)}
                                  style={{ flex:1, padding:'8px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                                  Decline
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={vehicleSearch} onChange={e => setVehicleSearch(e.target.value)} placeholder="Search plate, unit, make, model, color..." style={{ ...inputStyle, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveVehicles(s => !s)} style={{ padding:'4px 10px', background: showActiveVehicles ? '#1a1f2e' : '#111', color: showActiveVehicles ? '#C9A227' : '#555', border:`1px solid ${showActiveVehicles ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveVehicles ? '● Active Only' : '○ Show All'}</button>
            </div>
            {!isReadOnly && (
              <button onClick={() => setShowAddVehicle(!showAddVehicle)}
                style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
                + Add Vehicle
              </button>
            )}
            {showAddVehicle && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Vehicle</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit *</label><input value={newVehicle.unit} onChange={e => setNewVehicle({...newVehicle, unit: e.target.value})} placeholder="Apt 214" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={() => addVehicle()} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Add Vehicle</button>
                  <button onClick={() => setShowAddVehicle(false)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
              </div>
            )}
            {filteredVehicles().map((v,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{v.color} {v.make} {v.model} {v.year}</p>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold', display:'block', marginBottom:'6px' }}>{v.is_active ? 'Active' : 'Inactive'}</span>
                    {!isReadOnly && <button onClick={() => removeVehicle(v.id)} style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Remove</button>}
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px' }}>
                  <div><span style={{ color:'#555' }}>Unit</span><br/><span style={{ color:'#aaa' }}>{v.unit}</span></div>
                  <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* SPACES */}
        {activeTab === 'spaces' && (
          <div>
            {spaces.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No spaces found for this property</p>
              </div>
            ) : (
              <>
                {/* Visual grid */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                  <div style={{ display:'flex', gap:'12px', marginBottom:'10px', flexWrap:'wrap' }}>
                    {[{color:'#4caf50', bg:'#1a3a1a', label:'Available'},{color:'#f44336', bg:'#3a1a1a', label:'Occupied'},{color:'#C9A227', bg:'#2a1e00', label:'Reserved'}].map(l => (
                      <div key={l.label} style={{ display:'flex', alignItems:'center', gap:'5px' }}>
                        <div style={{ width:'12px', height:'12px', borderRadius:'3px', background:l.bg, border:`1px solid ${l.color}` }} />
                        <span style={{ color:'#aaa', fontSize:'11px' }}>{l.label}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(52px, 1fr))', gap:'6px' }}>
                    {spaces.map((s) => {
                      const isOccupied = s.status === 'occupied'
                      const isReserved = s.status === 'reserved'
                      const borderColor = isOccupied ? '#f44336' : isReserved ? '#C9A227' : '#4caf50'
                      const bgColor = isOccupied ? '#3a1a1a' : isReserved ? '#2a1e00' : '#1a3a1a'
                      const isHovered = hoveredSpaceId === s.id
                      return (
                        <div key={s.id}
                          onClick={() => setHoveredSpaceId(isHovered ? null : s.id)}
                          style={{ background:bgColor, border:`2px solid ${borderColor}`, borderRadius:'6px', padding:'6px 4px', textAlign:'center', cursor:'pointer', position:'relative', userSelect:'none' }}>
                          <span style={{ color:'white', fontSize:'10px', fontWeight:'bold', display:'block', lineHeight:'1.2' }}>{s.space_number}</span>
                          {s.location_notes && (
                            <p style={{ color:'#666', fontSize:'10px', margin:'2px 0 0', fontStyle:'italic', lineHeight:'1.3' }}>{s.location_notes}</p>
                          )}
                          {isHovered && (isOccupied || isReserved) && (
                            <div style={{ position:'absolute', top:'calc(100% + 4px)', left:'50%', transform:'translateX(-50%)', background:'#0f1117', border:'1px solid #3a4055', borderRadius:'6px', padding:'6px 8px', zIndex:20, minWidth:'110px', pointerEvents:'none' }}>
                              <p style={{ color:'#aaa', fontSize:'10px', margin:'0', whiteSpace:'nowrap' }}>
                                {isOccupied ? `${s.assigned_to_unit || '—'} · ${s.assigned_to_plate || '—'}` : (s.notes || 'Reserved')}
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Space list */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', overflow:'hidden' }}>
                  {/* Header row */}
                  <div style={{ display:'grid', gridTemplateColumns:'80px 80px 1fr 1fr 28px', gap:'8px', padding:'8px 12px', borderBottom:'1px solid #2a2f3d', background:'#1e2535' }}>
                    {['Space','Status','Unit','Plate',''].map((h,i) => (
                      <span key={i} style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>{h}</span>
                    ))}
                  </div>

                  {spaces.map((s) => (
                    <div key={s.id}>
                      <div style={{ display:'grid', gridTemplateColumns:'80px 80px 1fr 1fr 28px', gap:'8px', padding:'10px 12px', borderBottom:'1px solid #1e2535', alignItems:'center' }}>
                        <span style={{ color:'white', fontWeight:'bold', fontSize:'12px', fontFamily:'Courier New' }}>{s.space_number}</span>
                        <span style={{
                          fontSize:'10px', fontWeight:'bold', padding:'2px 7px', borderRadius:'8px', textAlign:'center',
                          background: s.status === 'occupied' ? '#3a1a1a' : s.status === 'reserved' ? '#2a1e00' : '#1a3a1a',
                          color: s.status === 'occupied' ? '#f44336' : s.status === 'reserved' ? '#C9A227' : '#4caf50',
                        }}>{s.status}</span>
                        <span style={{ color:'#aaa', fontSize:'12px' }}>{s.assigned_to_unit || '—'}</span>
                        <span style={{ color:'#aaa', fontSize:'12px', fontFamily: s.assigned_to_plate ? 'Courier New' : undefined }}>{s.assigned_to_plate || '—'}</span>
                        {!isReadOnly && (
                          <button
                            onClick={() => { setEditingSpace({ ...s }); setSpaceError('') }}
                            style={{ padding:'3px 7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', fontFamily:'Arial' }}>
                            Edit
                          </button>
                        )}
                      </div>

                      {/* Inline edit form */}
                      {editingSpace?.id === s.id && (
                        <div style={{ background:'#0f1117', borderBottom:'1px solid #2a2f3d', padding:'14px 12px' }}>
                          <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0 0 12px' }}>Editing Space {s.space_number}</p>

                          {spaceError && (
                            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                              <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spaceError}</p>
                            </div>
                          )}

                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Status</label>
                          <select
                            value={editingSpace.status}
                            onChange={e => setEditingSpace({ ...editingSpace, status: e.target.value })}
                            style={inputStyle}>
                            <option value='available'>Available</option>
                            <option value='occupied'>Occupied</option>
                            <option value='reserved'>Reserved</option>
                          </select>

                          {editingSpace.status !== 'available' && (
                            <>
                              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Assigned Unit</label>
                              <input
                                value={editingSpace.assigned_to_unit || ''}
                                onChange={e => setEditingSpace({ ...editingSpace, assigned_to_unit: e.target.value })}
                                placeholder="Apt 214"
                                style={inputStyle} />

                              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Assigned Plate</label>
                              <div style={{ position:'relative' }}>
                                <input
                                  value={plateQuery}
                                  onChange={e => handlePlateSearch(e.target.value.toUpperCase())}
                                  placeholder="Type plate to search..."
                                  style={{ ...inputStyle, fontFamily:'Courier New', fontWeight:'bold' }}
                                />
                                {plateSuggestions.length > 0 && (
                                  <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', zIndex:10, maxHeight:'160px', overflowY:'auto', boxShadow:'0 4px 12px rgba(0,0,0,0.4)' }}>
                                    {plateSuggestions.map((v, i) => (
                                      <div key={i} onClick={() => selectPlate(v.plate)}
                                        style={{ padding:'8px 12px', cursor:'pointer', borderBottom:'1px solid #2a2f3d', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                                        <span style={{ fontFamily:'Courier New', fontWeight:'bold', fontSize:'13px', color:'#C9A227' }}>{v.plate}</span>
                                        <span style={{ color:'#888', fontSize:'11px' }}>{v.unit} · {v.color} {v.make}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              {plateMsg && (
                                <div style={{ background: plateMsg.type === 'error' ? '#3a1a1a' : '#1a1a0a', border:`1px solid ${plateMsg.type === 'error' ? '#b71c1c' : '#a16207'}`, borderRadius:'6px', padding:'7px 10px', marginTop:'4px' }}>
                                  <p style={{ color: plateMsg.type === 'error' ? '#f44336' : '#fbbf24', fontSize:'11px', margin:'0' }}>{plateMsg.text}</p>
                                </div>
                              )}
                            </>
                          )}

                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Notes</label>
                          <input
                            value={editingSpace.notes || ''}
                            onChange={e => setEditingSpace({ ...editingSpace, notes: e.target.value })}
                            placeholder="Optional notes"
                            style={inputStyle} />

                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Location Notes (optional)</label>
                          <textarea
                            rows={2}
                            value={editingSpace.location_notes || ''}
                            onChange={e => setEditingSpace({ ...editingSpace, location_notes: e.target.value })}
                            placeholder="e.g. Building A near elevator, Lot B row 3, Covered parking level 2"
                            style={{ ...inputStyle, resize:'vertical', fontFamily:'Arial' }} />

                          <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                            <button onClick={saveSpace} style={{ flex:1, padding:'9px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'7px', cursor:'pointer' }}>Save</button>
                            <button onClick={() => { setEditingSpace(null); setSpaceError('') }} style={{ padding:'9px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {/* Notes row if no edit open */}
                      {editingSpace?.id !== s.id && s.notes && (
                        <div style={{ padding:'4px 12px 8px', borderBottom:'1px solid #1e2535' }}>
                          <span style={{ color:'#555', fontSize:'10px' }}>{s.notes}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* RESIDENTS */}
        {activeTab === 'residents' && (
          <div>
            {pendingResidents.length > 0 && (
              <div style={{ background:'#1a1400', border:'1px solid #a16207', borderRadius:'10px', padding:'14px', marginBottom:'16px' }}>
                <p style={{ color:'#fbbf24', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px' }}>
                  Pending Resident Registrations ({pendingResidents.length})
                </p>
                {pendingResidents.map(r => (
                  <div key={r.id} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{r.name}</p>
                        <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{r.unit} · {r.email}</p>
                        {r.phone && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{r.phone}</p>}
                      </div>
                      <span style={{ background:'#2a1e00', color:'#fbbf24', border:'1px solid #a16207', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', whiteSpace:'nowrap' }}>Pending</span>
                    </div>
                    {(() => {
                      const unitVehicles = vehicles.filter(v => v.unit?.toLowerCase() === r.unit?.toLowerCase() && v.status === 'pending')
                      return unitVehicles.length > 0 ? (
                        <div style={{ marginBottom:'10px' }}>
                          <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 6px' }}>Pending Vehicles</p>
                          {unitVehicles.map((v, i) => (
                            <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 8px', background:'#0f1117', borderRadius:'6px', marginBottom:'4px' }}>
                              <span style={{ color:'white', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                              <span style={{ color:'#888', fontSize:'11px' }}>{[v.color, v.make, v.model].filter(Boolean).join(' ')}</span>
                            </div>
                          ))}
                        </div>
                      ) : null
                    })()}
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Note (optional)</label>
                    <input
                      value={residentNotes[r.id] || ''}
                      onChange={e => setResidentNotes(n => ({...n, [r.id]: e.target.value}))}
                      placeholder="e.g. Welcome! or Missing documentation."
                      style={{ ...inputStyle, marginTop:'4px', marginBottom:'10px' }}
                    />
                    {!isReadOnly && (
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => approveResident(r)}
                          style={{ flex:1, padding:'8px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Approve
                        </button>
                        <button onClick={() => declineResident(r)}
                          style={{ flex:1, padding:'8px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={residentSearch} onChange={e => setResidentSearch(e.target.value)} placeholder="Search name, email, unit, phone..." style={{ ...inputStyle, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveResidents(s => !s)} style={{ padding:'4px 10px', background: showActiveResidents ? '#1a1f2e' : '#111', color: showActiveResidents ? '#C9A227' : '#555', border:`1px solid ${showActiveResidents ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveResidents ? '● Active Only' : '○ Show All'}</button>
            </div>
            {!isReadOnly && (
              <button onClick={() => setShowAddResident(!showAddResident)}
                style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
                + Add Resident
              </button>
            )}
            {showAddResident && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Resident</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Full Name *</label><input value={newResident.name} onChange={e => setNewResident({...newResident, name: e.target.value})} placeholder="John Smith" style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Email *</label><input value={newResident.email} onChange={e => setNewResident({...newResident, email: e.target.value})} placeholder="john@email.com" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Phone</label><input value={newResident.phone} onChange={e => setNewResident({...newResident, phone: e.target.value})} placeholder="713-555-0100" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit *</label><input value={newResident.unit} onChange={e => setNewResident({...newResident, unit: e.target.value})} placeholder="Apt 214" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newResident.space} onChange={e => setNewResident({...newResident, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Lease End</label><input type="date" value={newResident.lease_end} onChange={e => setNewResident({...newResident, lease_end: e.target.value})} style={inputStyle} /></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addResident} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Add Resident</button>
                  <button onClick={() => setShowAddResident(false)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
              </div>
            )}
            {editingResident && (
              <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingResident.unit}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Full Name</label><input value={editingResident.name || ''} onChange={e => setEditingResident({...editingResident, name: e.target.value})} style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Email</label><input value={editingResident.email || ''} onChange={e => setEditingResident({...editingResident, email: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Phone</label><input value={editingResident.phone || ''} onChange={e => setEditingResident({...editingResident, phone: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit</label><input value={editingResident.unit || ''} onChange={e => setEditingResident({...editingResident, unit: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={editingResident.space || ''} onChange={e => setEditingResident({...editingResident, space: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Lease End</label><input type="date" value={editingResident.lease_end || ''} onChange={e => setEditingResident({...editingResident, lease_end: e.target.value})} style={inputStyle} /></div>
                </div>
                <div style={{ display:'flex', gap:'8px', marginTop:'4px', marginBottom:'16px' }}>
                  <button onClick={saveResident} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Save Changes</button>
                  <button onClick={() => setEditingResident(null)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
                <div style={{ borderTop:'1px solid #2a2f3d', paddingTop:'14px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
                    <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>Vehicles — {editingResident.unit}</p>
                    <button onClick={() => setShowAddVehicle(true)} style={{ padding:'5px 10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'11px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>+ Add Vehicle</button>
                  </div>
                  {showAddVehicle && (
                    <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
                      </div>
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => addVehicle(editingResident.unit)} style={{ flex:1, padding:'9px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer' }}>Add Vehicle</button>
                        <button onClick={() => setShowAddVehicle(false)} style={{ padding:'9px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {vehicles.filter(v => v.unit?.toLowerCase() === editingResident.unit?.toLowerCase()).length === 0
                    ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No vehicles for this unit</p>
                    : vehicles.filter(v => v.unit?.toLowerCase() === editingResident.unit?.toLowerCase()).map((v,i) => (
                      <div key={i} style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'6px' }}>
                          <div>
                            <p style={{ color:'white', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                            <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{v.color} {v.make} {v.model} {v.year}</p>
                          </div>
                          <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', alignSelf:'flex-start' }}>{v.is_active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'6px', fontSize:'11px', marginBottom:'8px' }}>
                          <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                          <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state}</span></div>
                          <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
                        </div>
                        <div style={{ display:'flex', gap:'6px' }}>
                          <button onClick={async () => { const space = prompt('Update space:', v.space || ''); if (space === null) return; await supabase.from('vehicles').update({ space }).eq('id', v.id); fetchVehicles(manager.name) }}
                            style={{ flex:1, padding:'6px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>Edit Space</button>
                          <button onClick={async () => { const plate = prompt('Update plate:', v.plate); if (plate === null) return; await supabase.from('vehicles').update({ plate: normalizePlate(plate) }).eq('id', v.id); fetchVehicles(manager.name) }}
                            style={{ flex:1, padding:'6px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Edit Plate</button>
                          <button onClick={() => removeVehicle(v.id)}
                            style={{ padding:'6px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Remove</button>
                        </div>
                        <button onClick={() => window.open(`https://www.findmytowedcar.org/advancesearch?plate=${v.plate}`, '_blank')}
                          style={{ color:'#C9A227', fontSize:'11px', background:'transparent', border:'none', cursor:'pointer', textDecoration:'underline', padding:'6px 0 2px', display:'block' }}>
                          🔍 Find Towed Vehicle (Houston & Harris County)
                        </button>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}
            {filteredResidents().map((r,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{r.name}</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{r.unit} · {r.email}</p>
                  </div>
                  <span style={{ background: r.is_active ? '#1a3a1a' : '#3a1a1a', color: r.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>{r.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Phone</span><br/><span style={{ color:'#aaa' }}>{r.phone || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{r.space || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Lease End</span><br/><span style={{ color:'#aaa' }}>{r.lease_end ? new Date(r.lease_end).toLocaleDateString() : '—'}</span></div>
                </div>
                <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' }}>
                  {!isReadOnly && (
                    <>
                      <button onClick={() => { setEditingResident(r); setShowAddVehicle(false) }}
                        style={{ flex:1, padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>Edit</button>
                      {r.is_active && <button onClick={() => deactivateResident(r.id)}
                        style={{ padding:'7px 12px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Deactivate</button>}
                    </>
                  )}
                  <button onClick={() => { setResetPwTarget(resetPwTarget === r.email ? null : r.email); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }}
                    style={{ padding:'7px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                    {resetPwTarget === r.email ? 'Cancel' : 'Reset Password'}
                  </button>
                </div>
                {resetPwTarget === r.email && (
                  <div style={{ marginTop:'10px', borderTop:'1px solid #2a2f3d', paddingTop:'10px' }}>
                    <input type="password" value={resetPwForm.newPw} onChange={e => setResetPwForm(f => ({...f, newPw: e.target.value}))}
                      placeholder="New password (min 8 chars)" style={{ ...inputStyle, marginBottom:'8px' }} />
                    <input type="password" value={resetPwForm.confirmPw} onChange={e => setResetPwForm(f => ({...f, confirmPw: e.target.value}))}
                      placeholder="Confirm new password" style={{ ...inputStyle, marginBottom:'8px' }} />
                    {resetPwMsg && (
                      <p style={{ color: resetPwMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0 0 8px' }}>{resetPwMsg}</p>
                    )}
                    <button onClick={resetResidentPassword}
                      style={{ width:'100%', padding:'8px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                      Save New Password
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* VIOLATIONS */}
        {activeTab === 'violations' && (
          <div>
            <div style={{ background:'#1a2a1a', border:'1px solid #2e7d32', borderRadius:'8px', padding:'12px 14px', marginBottom:'12px' }}>
              <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'12px', margin:'0 0 2px' }}>View Only</p>
              <p style={{ color:'#aaa', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>Violations are filed by enforcement drivers. Contact your company administrator to report an issue.</p>
            </div>
            <input value={violationSearch} onChange={e => setViolationSearch(e.target.value)} placeholder="Search plate, violation type, location..." style={{ ...inputStyle, marginBottom:'10px' }} />
            <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex:1, padding:'8px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', background: violationFilter === f.k ? '#C9A227' : 'transparent', color: violationFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>
            {filteredViolations().length === 0
              ? <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations for this period</p></div>
              : filteredViolations().map((v,i) => (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
                    <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                    <div><span style={{ color:'#555' }}>Type</span><br/><span style={{ color:'#aaa' }}>{v.violation_type || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Location</span><br/><span style={{ color:'#aaa' }}>{v.location || '—'}</span></div>
                    {v.notes && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Notes</span><br/><span style={{ color:'#aaa' }}>{v.notes}</span></div>}
                  </div>
                  {(v.vehicle_color || v.vehicle_make || v.vehicle_model) && (
                    <p style={{ color:'#555', fontSize:'11px', margin:'8px 0 0' }}>🚗 {[v.vehicle_color, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</p>
                  )}
                  {v.photos && v.photos.length > 0 && (
                    <div style={{ marginTop:'8px' }}>
                      <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', margin:'0 0 6px' }}>Photos</p>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px' }}>
                        {v.photos.map((url: string, pi: number) => (
                          <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                            <img src={url} alt={`Photo ${pi+1}`} style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d' }} />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {v.video_url && (
                    <button onClick={() => window.open(v.video_url, '_blank')}
                      style={{ width:'100%', padding:'7px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial', marginTop:'8px' }}>
                      ▶ Play Video
                    </button>
                  )}
                  {v.tow_ticket_generated && (
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:'10px', paddingTop:'10px', borderTop:'1px solid #2a2f3d' }}>
                      <span style={{ background:'#1a1500', border:'1px solid #C9A227', color:'#C9A227', fontSize:'10px', fontWeight:'bold', padding:'3px 8px', borderRadius:'4px', letterSpacing:'0.05em' }}>🎫 TOW TICKET ISSUED</span>
                      <button onClick={() => reprintTicket(v)}
                        style={{ padding:'6px 12px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                        Reprint Ticket
                      </button>
                    </div>
                  )}
                  <button onClick={() => window.open(`https://www.findmytowedcar.org/advancesearch?plate=${v.plate}`, '_blank')}
                    style={{ color:'#C9A227', fontSize:'11px', background:'transparent', border:'none', cursor:'pointer', textDecoration:'underline', padding:'6px 0 2px', display:'block' }}>
                    🔍 Find this vehicle — FindMyTowedCar.org (Houston & Harris County)
                  </button>
                </div>
              ))
            }
          </div>
        )}

        {/* SETTINGS */}
        {activeTab === 'settings' && (
          <div>
            {/* Section A — Visitor Pass Limit */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Visitor Pass Limit</p>
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>Max visitor passes per plate per year. Leave blank for unlimited. Applies to all visitors at this property.</p>
              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Max Passes Per Plate Per Year</label>
              <input
                type="number"
                min="0"
                value={passLimit}
                onChange={e => { setPassLimit(e.target.value); setSettingsMsg('') }}
                placeholder="Unlimited"
                disabled={isReadOnly}
                style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'9px 10px', background: isReadOnly ? '#1a1a2a' : '#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color: isReadOnly ? '#555' : 'white', fontSize:'13px', boxSizing:'border-box', outline:'none' }}
              />
              {!isReadOnly && (
                <button onClick={savePassLimit}
                  style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                  Save Pass Limit
                </button>
              )}
              {settingsMsg && (
                <p style={{ color: settingsMsg.startsWith('Error') ? '#f44336' : '#4caf50', fontSize:'12px', margin:'10px 0 0' }}>{settingsMsg}</p>
              )}
            </div>

            {/* Section B — Registration QR */}
            {manager && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>New Resident Registration Link</p>
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 16px', lineHeight:'1.5' }}>Share this QR code or link with new residents to allow them to self-register. Their account will require your approval before they can log in.</p>
                {(() => {
                  const regUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'}/register?property=${encodeURIComponent(manager.name)}${managerCompany ? `&company=${encodeURIComponent(managerCompany)}` : ''}`
                  return (
                    <>
                      <div id="qr-registration" style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                        <QRCodeCanvas value={regUrl} size={160} level="H" />
                      </div>
                      <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New', textAlign:'center' }}>{regUrl}</p>
                      <button onClick={() => {
                        const canvas = document.querySelector('#qr-registration canvas') as HTMLCanvasElement
                        if (!canvas) return
                        const tw = window.open('', '_blank')!
                        tw.document.write(`<html><head><title>Registration QR - ${manager.name}</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:Arial,sans-serif;padding:40px}img{width:220px;height:220px}h2{color:#1A1F2E;font-size:22px;margin:16px 0 8px}p{color:#555;font-size:13px;text-align:center;max-width:320px;margin:4px 0}a{color:#C9A227;font-size:11px;word-break:break-all}</style></head><body><img src="${canvas.toDataURL()}" /><h2>${manager.name}</h2><p>Scan to register as a new resident</p><p>Your account requires manager approval before login</p><a>${regUrl}</a><script>window.print();window.close();</script></body></html>`)
                        tw.document.close()
                      }} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Print QR Code
                      </button>
                    </>
                  )
                })()}
              </div>
            )}

            {/* Section C — Exempt Plates */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Exempt Plates</p>
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>These plates bypass the annual visitor pass limit entirely.</p>

              {exemptPlates.length === 0 ? (
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px' }}>No exempt plates yet.</p>
              ) : (
                <div style={{ marginBottom:'14px' }}>
                  {exemptPlates.map(plate => (
                    <div key={plate} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 10px', background:'#1e2535', borderRadius:'6px', marginBottom:'6px' }}>
                      <span style={{ color:'white', fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold', letterSpacing:'0.08em' }}>{plate}</span>
                      {!isReadOnly && (
                        <button onClick={() => removeExemptPlate(plate)}
                          style={{ padding:'3px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'5px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!isReadOnly && (
                <div style={{ display:'flex', gap:'8px' }}>
                  <input
                    value={newExemptPlate}
                    onChange={e => setNewExemptPlate(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && addExemptPlate()}
                    placeholder="ABC1234"
                    style={{ flex:1, padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', fontFamily:'Courier New', fontWeight:'bold', outline:'none', boxSizing:'border-box' as const }}
                  />
                  <button onClick={addExemptPlate}
                    style={{ padding:'9px 16px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                    Add
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ACTIVITY LOG */}
        {activeTab === 'activity' && (() => {
          const today = new Date(); today.setHours(0,0,0,0)
          const week = new Date(); week.setDate(week.getDate()-7)
          const filtered = auditLogs.filter(log => {
            const d = new Date(log.created_at)
            const inPeriod = auditDateFilter === 'today' ? d >= today : auditDateFilter === 'week' ? d >= week : true
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
                {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'all',l:'All'}].map(f => (
                  <button key={f.k} onClick={() => setAuditDateFilter(f.k)}
                    style={{ flex:1, padding:'7px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', background: auditDateFilter === f.k ? '#C9A227' : 'transparent', color: auditDateFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                    {f.l}
                  </button>
                ))}
              </div>
              <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search email, action..." style={{ ...inputStyle, marginBottom:'10px' }} />
              {!auditLoaded ? (
                <p style={{ color:'#555', fontSize:'13px', textAlign:'center', margin:'32px 0' }}>Loading...</p>
              ) : filtered.length === 0 ? (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                  <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No activity for this period</p>
                </div>
              ) : filtered.map((log, i) => {
                const vals = log.new_values ? Object.entries(log.new_values).filter(([k]) => k !== 'property').map(([k,v]) => `${k}: ${v}`).join(' · ') : ''
                return (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                      <span style={{ background:'#1e1800', color:'#C9A227', padding:'2px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', letterSpacing:'0.04em' }}>{log.action}</span>
                      <span style={{ color:'#888', fontSize:'10px' }}>{new Date(log.created_at).toLocaleString()}</span>
                    </div>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>{log.user_email}</p>
                    {vals && <p style={{ color:'#888', fontSize:'11px', margin:'0', fontFamily:'Courier New' }}>{vals}</p>}
                  </div>
                )
              })}
            </div>
          )
        })()}

        {/* VISITORS */}
        {activeTab === 'visitors' && (
          <div>
            {passes.length === 0
              ? <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active visitor passes</p></div>
              : passes.map((p,i) => (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
                    <p style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{p.plate}</p>
                    <span style={{ background:'#1a3a1a', color:'#4caf50', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>Active</span>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                    <div><span style={{ color:'#555' }}>Visiting</span><br/><span style={{ color:'#aaa' }}>{p.visiting_unit}</span></div>
                    <div><span style={{ color:'#555' }}>Visitor</span><br/><span style={{ color:'#aaa' }}>{p.visitor_name || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Vehicle</span><br/><span style={{ color:'#aaa' }}>{p.vehicle_desc || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Duration</span><br/><span style={{ color:'#aaa' }}>{p.duration_hours} hours</span></div>
                    <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Expires</span><br/><span style={{ color:'#f59e0b' }}>{new Date(p.expires_at).toLocaleString()}</span></div>
                  </div>
                </div>
              ))
            }
          </div>
        )}


        {/* DISPUTES */}
        {activeTab === 'disputes' && (
          <div>
            {disputes.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No disputes filed for this property</p>
              </div>
            ) : disputes.map((d, i) => {
              const statusBadge = d.status === 'pending'
                ? { text:'Pending', bg:'#1a1200', color:'#f59e0b' }
                : d.status === 'upheld'
                  ? { text:'Tow Upheld', bg:'#3a1a1a', color:'#f44336' }
                  : { text:'Resolved in Resident\'s Favor', bg:'#1a3a1a', color:'#4caf50' }
              return (
                <div key={i} style={{ background:'#161b26', border:`1px solid ${d.status === 'pending' ? '#f59e0b44' : '#2a2f3d'}`, borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                    <div>
                      <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{d.resident_email}</p>
                      <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>Filed {new Date(d.created_at).toLocaleDateString()} at {new Date(d.created_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</p>
                    </div>
                    <span style={{ background:statusBadge.bg, color:statusBadge.color, padding:'3px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', border:`1px solid ${statusBadge.color}44` }}>{statusBadge.text}</span>
                  </div>
                  <div style={{ background:'#0f1117', borderRadius:'7px', padding:'10px 12px', marginBottom:'10px', fontSize:'12px' }}>
                    <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 6px' }}>Violation</p>
                    <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0 0 4px' }}>{violations.find(v => v.id === d.violation_id)?.plate || '—'}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'0' }}>{violations.find(v => v.id === d.violation_id)?.violation_type || '—'} · {violations.find(v => v.id === d.violation_id)?.created_at ? new Date(violations.find(v => v.id === d.violation_id).created_at).toLocaleDateString() : ''}</p>
                  </div>
                  <div style={{ marginBottom:'10px' }}>
                    <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>Reason</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'0' }}>{d.reason}</p>
                    {d.details && <p style={{ color:'#777', fontSize:'11px', margin:'6px 0 0', lineHeight:'1.5' }}>{d.details}</p>}
                  </div>
                  {d.evidence_url && (
                    <div style={{ marginBottom:'10px' }}>
                      <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>Evidence</p>
                      <a href={d.evidence_url} target="_blank" rel="noopener noreferrer">
                        <img src={d.evidence_url} alt="Evidence" style={{ width:'80px', height:'80px', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d', cursor:'pointer' }} />
                      </a>
                    </div>
                  )}
                  {d.status === 'pending' && !isReadOnly && (
                    <div>
                      <textarea value={disputeNotes[d.id] || ''} onChange={e => setDisputeNotes(prev => ({...prev, [d.id]: e.target.value}))}
                        placeholder="Optional note to resident about this decision..."
                        style={{ display:'block', width:'100%', padding:'8px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'12px', marginBottom:'8px', minHeight:'56px', resize:'vertical' as const, boxSizing:'border-box' as const }} />
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => upholdDispute(d)}
                          style={{ flex:1, padding:'9px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Uphold Tow
                        </button>
                        <button onClick={() => resolveDispute(d)}
                          style={{ flex:1, padding:'9px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Resolve in Resident's Favor
                        </button>
                      </div>
                    </div>
                  )}
                  {d.status !== 'pending' && (
                    <div style={{ borderTop:'1px solid #2a2f3d', paddingTop:'8px', marginTop:'8px' }}>
                      {d.pm_note && <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>Manager note: {d.pm_note}</p>}
                      {d.resolved_at && <p style={{ color:'#555', fontSize:'10px', margin:'0' }}>Decided {new Date(d.resolved_at).toLocaleDateString()}</p>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {activeTab === 'insights' && (
          <div>
            {!insightsLoaded ? (
              <p style={{ color:'#555', textAlign:'center', padding:'40px' }}>Loading insights...</p>
            ) : !mgAnalytics ? null : (
              <>
                {/* Metric cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                  {[
                    { label:'This Month', val:mgAnalytics.thisMonthCount, sub: mgAnalytics.lastMonthCount > 0 ? `${mgAnalytics.thisMonthCount > mgAnalytics.lastMonthCount ? '↑' : '↓'} ${Math.abs(mgAnalytics.thisMonthCount - mgAnalytics.lastMonthCount)} vs last mo` : '—', subColor: mgAnalytics.thisMonthCount > mgAnalytics.lastMonthCount ? '#E24B4A' : '#1D9E75' },
                    { label:'Last Month', val:mgAnalytics.lastMonthCount, sub:'violations', subColor:'#555' },
                    { label:'Vehicle Compliance', val:`${mgAnalytics.complianceRate}%`, sub:'of vehicles registered', subColor:'#555', valColor: mgAnalytics.complianceRate >= 80 ? '#1D9E75' : '#E24B4A' },
                    { label:'Dispute Rate', val:`${mgAnalytics.disputeRate}%`, sub:'of violations disputed', subColor:'#555', valColor: mgAnalytics.disputeRate > 5 ? '#E24B4A' : '#1D9E75' },
                  ].map((c, i) => (
                    <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                      <p style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>{c.label}</p>
                      <p style={{ color:(c as any).valColor || 'white', fontSize:'26px', fontWeight:'bold', margin:'0', fontFamily:'Arial' }}>{c.val}</p>
                      <p style={{ color:c.subColor, fontSize:'11px', margin:'4px 0 0', fontWeight:c.subColor !== '#555' ? 'bold' : 'normal' }}>{c.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Violations by day of week */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Violations by Day of Week</p>
                  <ResponsiveContainer width="100%" height={170}>
                    <BarChart data={mgAnalytics.dayChartData} margin={{ top:4, right:0, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="name" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} itemStyle={{ color:'#C9A227' }} />
                      <Bar dataKey="count" name="Violations" radius={[4,4,0,0]}>
                        {mgAnalytics.dayChartData.map((entry: any, i: number) => (
                          <Cell key={i} fill={entry.name === 'Fri' || entry.name === 'Sat' ? '#C9A227' : '#546E7A'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Monthly trend */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Monthly Trend (6 Months)</p>
                  <ResponsiveContainer width="100%" height={170}>
                    <LineChart data={mgAnalytics.monthData} margin={{ top:4, right:4, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="month" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} itemStyle={{ color:'#C9A227' }} />
                      <Line type="monotone" dataKey="count" stroke="#C9A227" strokeWidth={2} dot={{ fill:'#C9A227', strokeWidth:0, r:3 }} activeDot={{ r:5 }} name="Violations" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Hourly heatmap */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Violations by Hour of Day</p>
                  {(() => {
                    const maxH = Math.max(...mgAnalytics.byHour, 1)
                    return (
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(12,1fr)', gap:'3px' }}>
                        {mgAnalytics.byHour.map((count: number, hour: number) => {
                          const intensity = count / maxH
                          const lbl = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`
                          return (
                            <div key={hour} title={`${lbl}: ${count} violations`}
                              style={{ background:`rgba(201,162,39,${Math.max(0.07, intensity)})`, borderRadius:'4px', padding:'5px 2px', textAlign:'center' }}>
                              <span style={{ color: intensity > 0.4 ? 'white' : '#555', fontSize:'8px', display:'block', lineHeight:'1.2' }}>{lbl}</span>
                              {count > 0 && <span style={{ color:'white', fontSize:'9px', fontWeight:'bold', display:'block' }}>{count}</span>}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>

                {/* Patrol insight */}
                <div style={{ background:'#1a1f2e', border:'1px solid rgba(201,162,39,0.2)', borderRadius:'10px', padding:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 8px' }}>📍 Patrol Insight</p>
                  <p style={{ color:'#aaa', fontSize:'13px', margin:'0', lineHeight:'1.6' }}>{mgAnalytics.insight}</p>
                </div>
              </>
            )}
          </div>
        )}

        {!isAdmin && managerCompany && (
          <div style={{ marginTop: 24 }}>
            <SupportContact role={isReadOnly ? 'leasing_agent' : 'manager'} company={managerCompany} />
          </div>
        )}

      </div>
    </main>
  )
}
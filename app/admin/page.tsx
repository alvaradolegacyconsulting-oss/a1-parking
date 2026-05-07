'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function AdminPortal() {
  const [adminEmail, setAdminEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('companies')

  const [companies, setCompanies] = useState<any[]>([])
  const [companySearch, setCompanySearch] = useState('')
  const [showAddCompany, setShowAddCompany] = useState(false)
  const [editingCompany, setEditingCompany] = useState<any>(null)
  const [newCompany, setNewCompany] = useState({ name:'', address:'', phone:'', email:'', is_active:true, display_name:'', logo_url:'', support_phone:'', support_email:'', support_website:'', tier_type:'enforcement', tier:'legacy', theme:'gold' })

  const [properties, setProperties] = useState<any[]>([])
  const [propertySearch, setPropertySearch] = useState('')
  const [showAddProperty, setShowAddProperty] = useState(false)
  const [editingProperty, setEditingProperty] = useState<any>(null)
  const [newProperty, setNewProperty] = useState({ name:'', company:'', address:'', city:'', state:'TX', zip:'', total_spaces:'', pm_name:'', pm_phone:'', pm_email:'', is_active:true })

  const [users, setUsers] = useState<any[]>([])
  const [userSearch, setUserSearch] = useState('')
  const [showAddUser, setShowAddUser] = useState(false)
  const [newUser, setNewUser] = useState({ email:'', password:'', role:'manager', company:'', property:'' })
  const [userMsg, setUserMsg] = useState('')
  const [showBulkUpload, setShowBulkUpload] = useState(false)
  const [bulkRows, setBulkRows] = useState<any[]>([])
  const [bulkResults, setBulkResults] = useState<{email:string,role:string,status:string,error?:string}[]>([])
  const [bulkProcessing, setBulkProcessing] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ current:0, total:0 })

  const [drivers, setDrivers] = useState<any[]>([])
  const [driverSearch, setDriverSearch] = useState('')
  const [showAddDriver, setShowAddDriver] = useState(false)
  const [editingDriver, setEditingDriver] = useState<any>(null)
  const [newDriver, setNewDriver] = useState({ name:'', email:'', phone:'', company:'', operator_license:'', assigned_properties:[] as string[], is_active:true })
  const [driverMsg, setDriverMsg] = useState('')

  const [facilities, setFacilities] = useState<any[]>([])
  const [facilitySearch, setFacilitySearch] = useState('')
  const [showAddFacility, setShowAddFacility] = useState(false)
  const [editingFacility, setEditingFacility] = useState<any>(null)
  const [newFacility, setNewFacility] = useState({ name:'', address:'', phone:'', email:'', is_active:true })

  const [resetPwTarget, setResetPwTarget] = useState<string | null>(null)
  const [resetPwForm, setResetPwForm] = useState({ newPw: '', confirmPw: '' })
  const [resetPwMsg, setResetPwMsg] = useState('')
  const [allAuditLogs, setAllAuditLogs] = useState<any[]>([])
  const [auditDateFilter, setAuditDateFilter] = useState('week')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)

  const [platformSettings, setPlatformSettings] = useState<any>({})
  const [platformMsg, setPlatformMsg] = useState('')
  const [pricingMsg, setPricingMsg] = useState('')
  const [logoUploadMsg, setLogoUploadMsg] = useState<Record<string,string>>({})
  const [calcTrack, setCalcTrack] = useState('enforcement')
  const [calcTier, setCalcTier] = useState('starter')
  const [calcProperties, setCalcProperties] = useState(5)
  const [calcDrivers, setCalcDrivers] = useState(2)

  const [showActiveCompanies, setShowActiveCompanies] = useState(true)
  const [showActiveProperties, setShowActiveProperties] = useState(true)
  const [showActiveUsers, setShowActiveUsers] = useState(true)
  const [showActiveDrivers, setShowActiveDrivers] = useState(true)
  const [showActiveFacilities, setShowActiveFacilities] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [adminAnalyticsLoaded, setAdminAnalyticsLoaded] = useState(false)
  const [adminAnalytics, setAdminAnalytics] = useState<any>(null)

  useEffect(() => { loadAdmin() }, [])
  useEffect(() => { if (activeTab === 'auditlog') fetchAuditLogs() }, [activeTab])
  useEffect(() => { if (activeTab === 'analytics' && companies.length > 0) fetchAdminAnalytics() }, [activeTab, companies])

  async function loadAdmin() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase.from('user_roles').select('role').ilike('email', user.email!).single()
    if (!roleData || roleData.role !== 'admin') { window.location.href = '/login'; return }

    setAdminEmail(user.email!)
    await Promise.all([fetchCompanies(), fetchProperties(), fetchUsers(), fetchDrivers(), fetchFacilities(), fetchPlatformSettings()])
    setLoading(false)
  }

  async function auditLog(email: string, action: string, table_name: string, record_id: any, new_values: any) {
    await supabase.from('audit_logs').insert([{
      user_email: email,
      action,
      table_name,
      record_id: String(record_id),
      new_values,
      created_at: new Date().toISOString()
    }])
  }

  async function fetchAuditLogs() {
    setAuditLoaded(false)
    const { data } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setAllAuditLogs(data || [])
    setAuditLoaded(true)
  }

  async function fetchPlatformSettings() {
    const { data } = await supabase.from('platform_settings').select('*').eq('id', 1).single()
    if (data) setPlatformSettings(data)
  }

  async function fetchAdminAnalytics() {
    setAdminAnalyticsLoaded(false)
    const now = new Date()
    const sixMoAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const mk = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`

    const { data: vData } = await supabase.from('violations').select('property,created_at').gte('created_at', sixMoAgo.toISOString())
    const viols = vData || []
    const thisMonthViolations = viols.filter((v: any) => new Date(v.created_at) >= thisMonthStart).length

    const monthLabels: { label: string; key: string }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      monthLabels.push({ label: d.toLocaleString('en-US', { month: 'short' }), key: mk(d) })
    }
    const byMonth: Record<string, number> = {}
    viols.forEach((v: any) => { const k = mk(new Date(v.created_at)); byMonth[k] = (byMonth[k] || 0) + 1 })
    const monthData = monthLabels.map(m => ({ month: m.label, count: byMonth[m.key] || 0 }))

    const byProp: Record<string, number> = {}
    viols.forEach((v: any) => { const p = v.property || 'Unknown'; byProp[p] = (byProp[p] || 0) + 1 })
    const topProperties = Object.entries(byProp).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count], i) => ({ rank: i + 1, name, count }))

    const tierColors: Record<string, string> = { legacy:'#C9A227', growth:'#1565C0', starter:'#546E7A', essential:'#2E7D32', professional:'#7B1FA2', enterprise:'#E65100' }
    const tierCounts: Record<string, number> = {}
    companies.filter((c: any) => c.is_active).forEach((c: any) => { const t = c.tier || 'legacy'; tierCounts[t] = (tierCounts[t] || 0) + 1 })
    const tierData = Object.entries(tierCounts).map(([name, value]) => ({ name, value, color: tierColors[name] || '#555' }))

    const activeCompanies = companies.filter((c: any) => c.is_active).length
    const totalProps = properties.length
    const totalDrivers = drivers.filter((d: any) => d.is_active !== false).length

    setAdminAnalytics({ monthData, topProperties, tierData, activeCompanies, thisMonthViolations, totalProps, totalDrivers })
    setAdminAnalyticsLoaded(true)
  }

  async function savePlatformSettings() {
    const { error } = await supabase.from('platform_settings').upsert({ id: 1, ...platformSettings, updated_at: new Date().toISOString() })
    if (error) { setPlatformMsg('Error saving settings'); return }
    await auditLog(adminEmail, 'UPDATE_PLATFORM_SETTINGS', 'platform_settings', '1', platformSettings)
    setPlatformMsg('Platform settings saved!')
    setTimeout(() => setPlatformMsg(''), 3000)
  }

  async function savePricing() {
    const priceFields = {
      // Enforcement — hybrid: base + per-property + per-driver
      price_enforcement_starter_base: platformSettings.price_enforcement_starter_base ?? 99,
      price_enforcement_starter_per_property: platformSettings.price_enforcement_starter_per_property ?? 15,
      price_enforcement_starter_per_driver: platformSettings.price_enforcement_starter_per_driver ?? 10,
      price_enforcement_growth_base: platformSettings.price_enforcement_growth_base ?? 149,
      price_enforcement_growth_per_property: platformSettings.price_enforcement_growth_per_property ?? 12,
      price_enforcement_growth_per_driver: platformSettings.price_enforcement_growth_per_driver ?? 8,
      price_enforcement_legacy_base: platformSettings.price_enforcement_legacy_base ?? 199,
      price_enforcement_legacy_per_property: platformSettings.price_enforcement_legacy_per_property ?? 10,
      price_enforcement_legacy_per_driver: platformSettings.price_enforcement_legacy_per_driver ?? 6,
      // PM — hybrid: base + per-property (no per-driver)
      price_pm_essential_base: platformSettings.price_pm_essential_base ?? 79,
      price_pm_essential_per_property: platformSettings.price_pm_essential_per_property ?? 20,
      price_pm_professional_base: platformSettings.price_pm_professional_base ?? 129,
      price_pm_professional_per_property: platformSettings.price_pm_professional_per_property ?? 15,
      price_pm_enterprise_base: platformSettings.price_pm_enterprise_base ?? 179,
      price_pm_enterprise_per_property: platformSettings.price_pm_enterprise_per_property ?? 10,
      // Add-ons
      addon_enforcement_starter_live_support: platformSettings.addon_enforcement_starter_live_support ?? 100,
      addon_enforcement_growth_live_support: platformSettings.addon_enforcement_growth_live_support ?? 50,
      addon_enforcement_starter_analytics: platformSettings.addon_enforcement_starter_analytics ?? 25,
      addon_enforcement_growth_analytics: platformSettings.addon_enforcement_growth_analytics ?? 15,
      addon_enforcement_starter_camera_scan: platformSettings.addon_enforcement_starter_camera_scan ?? 20,
      addon_enforcement_starter_video_upload: platformSettings.addon_enforcement_starter_video_upload ?? 15,
      addon_enforcement_growth_video_upload: platformSettings.addon_enforcement_growth_video_upload ?? 10,
      addon_enforcement_starter_white_label: platformSettings.addon_enforcement_starter_white_label ?? 30,
      addon_enforcement_starter_extra_property: platformSettings.addon_enforcement_starter_extra_property ?? 10,
      addon_enforcement_growth_extra_property: platformSettings.addon_enforcement_growth_extra_property ?? 8,
      addon_enforcement_legacy_extra_property: platformSettings.addon_enforcement_legacy_extra_property ?? 5,
      addon_enforcement_starter_extra_driver: platformSettings.addon_enforcement_starter_extra_driver ?? 8,
      addon_enforcement_growth_extra_driver: platformSettings.addon_enforcement_growth_extra_driver ?? 5,
      addon_enforcement_legacy_extra_driver: platformSettings.addon_enforcement_legacy_extra_driver ?? 3,
      addon_pm_essential_live_support: platformSettings.addon_pm_essential_live_support ?? 100,
      addon_pm_professional_live_support: platformSettings.addon_pm_professional_live_support ?? 50,
      addon_pm_essential_analytics: platformSettings.addon_pm_essential_analytics ?? 20,
      addon_pm_professional_analytics: platformSettings.addon_pm_professional_analytics ?? 10,
      addon_pm_essential_visitor_qr: platformSettings.addon_pm_essential_visitor_qr ?? 15,
      addon_pm_essential_registration_qr: platformSettings.addon_pm_essential_registration_qr ?? 15,
      addon_pm_professional_registration_qr: platformSettings.addon_pm_professional_registration_qr ?? 10,
      addon_pm_essential_extra_property: platformSettings.addon_pm_essential_extra_property ?? 8,
      addon_pm_professional_extra_property: platformSettings.addon_pm_professional_extra_property ?? 6,
      addon_pm_enterprise_extra_property: platformSettings.addon_pm_enterprise_extra_property ?? 4,
    }
    const { error } = await supabase.from('platform_settings').upsert({ id: 1, ...priceFields, updated_at: new Date().toISOString() })
    if (error) { setPricingMsg('Error saving pricing'); return }
    setPlatformSettings((prev: any) => ({ ...prev, ...priceFields }))
    await auditLog(adminEmail, 'UPDATE_PRICING', 'platform_settings', '1', priceFields)
    setPricingMsg('Pricing updated successfully!')
    setTimeout(() => setPricingMsg(''), 3000)
  }

  async function uploadLogo(file: File, pathPrefix: string, slot: string, onSuccess: (url: string) => void) {
    if (file.size > 2 * 1024 * 1024) {
      setLogoUploadMsg(m => ({ ...m, [slot]: 'File exceeds 2MB limit' }))
      return
    }
    setLogoUploadMsg(m => ({ ...m, [slot]: 'Uploading...' }))
    const ext = file.name.split('.').pop() || 'png'
    const filePath = `${pathPrefix}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('logos').upload(filePath, file, { upsert: true })
    if (error) {
      setLogoUploadMsg(m => ({ ...m, [slot]: 'Upload failed: ' + error.message }))
      return
    }
    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(filePath)
    onSuccess(urlData.publicUrl)
    setLogoUploadMsg(m => ({ ...m, [slot]: 'Logo uploaded!' }))
    setTimeout(() => setLogoUploadMsg(m => ({ ...m, [slot]: '' })), 3000)
  }

  async function fetchCompanies() {
    const { data } = await supabase.from('companies').select('*').order('name')
    setCompanies(data || [])
  }

  async function addCompany() {
    if (!newCompany.name) { alert('Name is required'); return }
    const { data, error } = await supabase.from('companies').insert([newCompany]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'ADD_COMPANY', 'companies', data.id, newCompany)
    setShowAddCompany(false)
    setNewCompany({ name:'', address:'', phone:'', email:'', is_active:true, display_name:'', logo_url:'', support_phone:'', support_email:'', support_website:'', tier_type:'enforcement', tier:'legacy', theme:'gold' })
    fetchCompanies()
  }

  async function saveCompany() {
    const { error } = await supabase.from('companies').update({
      name: editingCompany.name, address: editingCompany.address,
      phone: editingCompany.phone, email: editingCompany.email, is_active: editingCompany.is_active,
      display_name: editingCompany.display_name || null, logo_url: editingCompany.logo_url || null,
      support_phone: editingCompany.support_phone || null, support_email: editingCompany.support_email || null,
      support_website: editingCompany.support_website || null,
      tier_type: editingCompany.tier_type || 'enforcement', tier: editingCompany.tier || 'legacy',
      theme: editingCompany.theme || 'gold'
    }).eq('id', editingCompany.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_COMPANY', 'companies', editingCompany.id, editingCompany)
    setEditingCompany(null)
    fetchCompanies()
  }

  async function toggleCompany(c: any, active: boolean) {
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()

    // 1. Fetch all non-admin users for this company
    const { data: companyUsers } = await supabase
      .from('user_roles')
      .select('email')
      .ilike('company', c.name)
      .neq('role', 'admin')

    // 2. Ban or unban all users in parallel via swift-handler
    if (companyUsers && companyUsers.length > 0) {
      await Promise.all(companyUsers.map(u =>
        fetch(fnBase + '/swift-handler', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: active ? 'activate_user' : 'deactivate_user', email: u.email }),
        })
      ))
    }

    // 3. Update drivers (facilities excluded — global)
    await supabase.from('drivers').update({ is_active: active }).ilike('company', c.name)

    // 4. Update properties
    await supabase.from('properties').update({ is_active: active }).ilike('company', c.name)

    // 5. Update company record
    await supabase.from('companies').update({ is_active: active }).eq('id', c.id)

    // 6. Audit log the cascade
    await auditLog(adminEmail, active ? 'ACTIVATE_COMPANY_CASCADE' : 'DEACTIVATE_COMPANY_CASCADE', 'companies', c.id, {
      is_active: active,
      users_affected: companyUsers?.length || 0,
    })
    fetchCompanies()
  }

  async function fetchProperties() {
    const { data } = await supabase.from('properties').select('*').order('name')
    setProperties(data || [])
  }

  async function addProperty() {
    if (!newProperty.name) { alert('Name is required'); return }
    const payload = { ...newProperty, total_spaces: parseInt(newProperty.total_spaces) || null }
    const { data, error } = await supabase.from('properties').insert([payload]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'ADD_PROPERTY', 'properties', data.id, payload)
    setShowAddProperty(false)
    setNewProperty({ name:'', company:'', address:'', city:'', state:'TX', zip:'', total_spaces:'', pm_name:'', pm_phone:'', pm_email:'', is_active:true })
    fetchProperties()
  }

  async function saveProperty() {
    const payload = { ...editingProperty, total_spaces: parseInt(editingProperty.total_spaces) || null }
    const { error } = await supabase.from('properties').update(payload).eq('id', editingProperty.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_PROPERTY', 'properties', editingProperty.id, payload)
    setEditingProperty(null)
    fetchProperties()
  }

  async function toggleProperty(p: any, active: boolean) {
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()
    const propertyName: string = p.name

    // Fetch managers / leasing_agents assigned to this property
    const { data: propertyUsers } = await supabase
      .from('user_roles')
      .select('email, role, property')
      .contains('property', [propertyName])
      .in('role', ['manager', 'leasing_agent'])

    if (!active) {
      // DEACTIVATING — only ban users with no other active properties
      if (propertyUsers && propertyUsers.length > 0) {
        const toDeactivate = propertyUsers.filter((u: any) =>
          ((u.property as string[]) || []).filter((prop: string) => prop.toLowerCase() !== propertyName.toLowerCase()).length === 0
        )
        if (toDeactivate.length > 0) {
          await Promise.all(toDeactivate.map((u: any) =>
            fetch(fnBase + '/swift-handler', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
              body: JSON.stringify({ action: 'deactivate_user', email: u.email }),
            })
          ))
        }
      }
      await supabase.from('residents').update({ is_active: false }).ilike('property', propertyName)
      await supabase.from('vehicles').update({ is_active: false }).ilike('property', propertyName)
      await supabase.from('properties').update({ is_active: false }).eq('id', p.id)
      await auditLog(adminEmail, 'DEACTIVATE_PROPERTY_CASCADE', 'properties', p.id, {
        property: propertyName, users_affected: propertyUsers?.length || 0,
      })
    } else {
      // REACTIVATING — unban all assigned managers / leasing_agents
      if (propertyUsers && propertyUsers.length > 0) {
        await Promise.all(propertyUsers.map((u: any) =>
          fetch(fnBase + '/swift-handler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
            body: JSON.stringify({ action: 'activate_user', email: u.email }),
          })
        ))
      }
      await supabase.from('residents').update({ is_active: true }).ilike('property', propertyName)
      await supabase.from('vehicles').update({ is_active: true }).ilike('property', propertyName)
      await supabase.from('properties').update({ is_active: true }).eq('id', p.id)
      await auditLog(adminEmail, 'ACTIVATE_PROPERTY_CASCADE', 'properties', p.id, {
        property: propertyName, users_affected: propertyUsers?.length || 0,
      })
    }
    fetchProperties()
  }

  async function fetchUsers() {
    const { data } = await supabase.from('user_roles').select('*').order('email')
    setUsers(data || [])
  }

  async function addUser() {
    if (!newUser.email || !newUser.password) { setUserMsg('Email and password are required'); return }
    setUserMsg('Creating account...')
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    console.log('Functions URL env:', fnBase)
    const { data: { session } } = await supabase.auth.getSession()
    const url = (fnBase ?? '') + '/swift-handler'
    const reqBody = JSON.stringify({ action: 'create_user', email: newUser.email, password: newUser.password })
    console.log('Edge function URL:', url)
    console.log('Request body:', reqBody)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: reqBody
      })
      console.log('Response status:', res.status)
      const text = await res.text()
      console.log('Response text:', text)
      const err = (() => { try { return JSON.parse(text) } catch { return {} } })()
      if (!res.ok) { setUserMsg('Auth error: ' + (err.error || err.message || res.statusText)); return }
    } catch (e: any) { console.log('Fetch threw:', e); setUserMsg('Error: ' + e.message); return }
    const propertyArray = newUser.property
      ? newUser.property.split('|').map(p => p.trim()).filter(Boolean)
      : []
    console.log('propertyArray type:', typeof propertyArray, 'value:', JSON.stringify(propertyArray), 'isArray:', Array.isArray(propertyArray))
    const { error: roleError } = await supabase
      .rpc('insert_user_role', {
        p_email: newUser.email.trim(),
        p_role: newUser.role,
        p_company: newUser.company.trim() || null,
        p_property: propertyArray.length > 0 ? propertyArray : []
      })
    if (roleError) { setUserMsg('Auth created but role insert failed: ' + roleError.message); return }
    if (newUser.role === 'resident') {
      await supabase.from('residents').insert([{
        email: newUser.email.trim(),
        name: newUser.email.trim(),
        property: propertyArray[0] || null,
        company: newUser.company.trim() || null,
        unit: '',
        is_active: true
      }])
    }
    if (newUser.role === 'driver') {
      await supabase.from('drivers').insert([{
        email: newUser.email.trim(),
        name: newUser.email.trim(),
        company: newUser.company.trim() || null,
        assigned_properties: propertyArray,
        is_active: true
      }])
    }
    await auditLog(adminEmail, 'ADD_USER', 'user_roles', newUser.email, { email: newUser.email, role: newUser.role })
    setUserMsg('User created successfully!')
    setNewUser({ email:'', password:'', role:'manager', company:'', property:'' })
    fetchUsers()
  }

  function downloadTemplate() {
    const csv = [
      'email,role,company,property,name',
      'example@email.com,manager,A1 Wrecker LLC,Miramar,John Smith',
      'example2@email.com,driver,A1 Wrecker LLC,Villa Barcelona,Jane Doe',
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'bulk_user_template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleBulkFile(file: File) {
    setBulkRows([]); setBulkResults([])
    if (file.name.match(/\.xlsx?$/i)) {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])
      const result = Papa.parse<any>(csv, { header: true, skipEmptyLines: true })
      setBulkRows(result.data)
    } else {
      Papa.parse<any>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => setBulkRows(result.data),
      })
    }
  }

  async function processBulkUsers() {
    setBulkProcessing(true); setBulkResults([])
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()

    for (let i = 0; i < bulkRows.length; i++) {
      const row = bulkRows[i]
      const email   = (row.email    || '').trim().toLowerCase()
      const role    = (row.role     || 'manager').trim().toLowerCase()
      const company = (row.company  || '').trim()
      const property = (row.property || '').trim()
      const name    = (row.name     || email).trim()

      setBulkProgress({ current: i + 1, total: bulkRows.length })

      if (!email) {
        setBulkResults(prev => [...prev, { email:'(blank)', role, status:'error', error:'Missing email' }])
        continue
      }

      const tempPassword = email.split('@')[0] + '!A1'

      try {
        const res = await fetch(fnBase + '/swift-handler', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'create_user', email, password: tempPassword }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setBulkResults(prev => [...prev, { email, role, status:'error', error: json.error || json.message || res.statusText }])
          continue
        }

        const propertyArray = property ? [property] : []
        const { error: roleErr } = await supabase.rpc('insert_user_role', {
          p_email: email, p_role: role, p_company: company || null, p_property: propertyArray,
        })
        if (roleErr) {
          setBulkResults(prev => [...prev, { email, role, status:'error', error: 'Role insert failed: ' + roleErr.message }])
          continue
        }

        if (role === 'resident') {
          await supabase.from('residents').insert([{ email, name, property: property || null, company: company || null, unit: '', is_active: true }])
        }
        if (role === 'driver') {
          await supabase.from('drivers').insert([{ email, name, company: company || null, assigned_properties: propertyArray, is_active: true }])
        }

        await auditLog(adminEmail, 'BULK_ADD_USER', 'user_roles', email, { email, role, company, property })
        setBulkResults(prev => [...prev, { email, role, status:'success' }])
      } catch (e: any) {
        setBulkResults(prev => [...prev, { email, role, status:'error', error: e.message }])
      }
    }

    setBulkProcessing(false)
    fetchUsers()
  }

  function downloadResults() {
    const csv = Papa.unparse(bulkResults.map(r => ({
      email: r.email, role: r.role, status: r.status,
      temp_password: r.status === 'success' ? r.email.split('@')[0] + '!A1' : '',
      error: r.error || '',
    })))
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'bulk_upload_results.csv'; a.click()
    URL.revokeObjectURL(url)
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

  async function fetchDrivers() {
    const { data } = await supabase.from('drivers').select('*').order('name')
    setDrivers(data || [])
  }

  async function addDriver() {
    if (!newDriver.name || !newDriver.email) { setDriverMsg('Name and email are required'); return }
    setDriverMsg('Creating driver...')
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    const { data: { session } } = await supabase.auth.getSession()
    const tempPass = Math.random().toString(36).slice(-8) + 'A1!'
    try {
      const res = await fetch(fnBase + '/swift-handler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'create_user', email: newDriver.email, password: tempPass })
      })
      const err = await res.json().catch(() => ({}))
      if (!res.ok) { setDriverMsg('Auth error: ' + (err.error || err.message || res.statusText)); return }
    } catch (e: any) { setDriverMsg('Error: ' + e.message); return }
    const { data, error } = await supabase.from('drivers').insert([{ ...newDriver }]).select().single()
    if (error) { setDriverMsg('Error: ' + error.message); return }
    await supabase.from('user_roles').insert([{ email: newDriver.email, role: 'driver', company: newDriver.company || null }])
    await auditLog(adminEmail, 'ADD_DRIVER', 'drivers', data.id, newDriver)
    setDriverMsg(`Driver created! Temp password: ${tempPass}`)
    setNewDriver({ name:'', email:'', phone:'', company:'', operator_license:'', assigned_properties:[], is_active:true })
    setShowAddDriver(false)
    fetchDrivers()
  }

  async function saveDriver() {
    const { error } = await supabase.from('drivers').update({
      name: editingDriver.name, phone: editingDriver.phone, company: editingDriver.company,
      operator_license: editingDriver.operator_license,
      assigned_properties: editingDriver.assigned_properties || [],
      is_active: editingDriver.is_active
    }).eq('id', editingDriver.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_DRIVER', 'drivers', editingDriver.id, editingDriver)
    setEditingDriver(null)
    fetchDrivers()
  }

  async function toggleDriver(d: any, active: boolean) {
    await supabase.from('drivers').update({ is_active: active }).eq('id', d.id)
    await auditLog(adminEmail, active ? 'ACTIVATE_DRIVER' : 'DEACTIVATE_DRIVER', 'drivers', d.id, { is_active: active })
    fetchDrivers()
  }

  async function fetchFacilities() {
    const { data } = await supabase.from('storage_facilities').select('*').order('name')
    setFacilities(data || [])
  }

  async function addFacility() {
    if (!newFacility.name) { alert('Name is required'); return }
    const { data, error } = await supabase.from('storage_facilities').insert([newFacility]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'ADD_FACILITY', 'storage_facilities', data.id, newFacility)
    setShowAddFacility(false)
    setNewFacility({ name:'', address:'', phone:'', email:'', is_active:true })
    fetchFacilities()
  }

  async function saveFacility() {
    const { error } = await supabase.from('storage_facilities').update({
      name: editingFacility.name, address: editingFacility.address,
      phone: editingFacility.phone, email: editingFacility.email, is_active: editingFacility.is_active
    }).eq('id', editingFacility.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_FACILITY', 'storage_facilities', editingFacility.id, editingFacility)
    setEditingFacility(null)
    fetchFacilities()
  }

  async function toggleFacility(f: any, active: boolean) {
    await supabase.from('storage_facilities').update({ is_active: active }).eq('id', f.id)
    await auditLog(adminEmail, active ? 'ACTIVATE_FACILITY' : 'DEACTIVATE_FACILITY', 'storage_facilities', f.id, { is_active: active })
    fetchFacilities()
  }

  const fC = () => { const q = companySearch.toLowerCase(); let l = companySearch ? companies.filter(c => c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)) : companies; return showActiveCompanies ? l.filter(c => c.is_active) : l }
  const fP = () => { const q = propertySearch.toLowerCase(); let l = propertySearch ? properties.filter(p => p.name?.toLowerCase().includes(q) || p.company?.toLowerCase().includes(q) || p.city?.toLowerCase().includes(q)) : properties; return showActiveProperties ? l.filter(p => p.is_active) : l }
  const fU = () => { const q = userSearch.toLowerCase(); let l = userSearch ? users.filter(u => u.email?.toLowerCase().includes(q) || u.role?.toLowerCase().includes(q) || u.company?.toLowerCase().includes(q)) : users; return showActiveUsers ? l.filter(u => u.is_active !== false) : l }
  function toggleGroup(role: string) {
    setCollapsedGroups(prev => { const next = new Set(prev); if (next.has(role)) next.delete(role); else next.add(role); return next })
  }
  const fD = () => { const q = driverSearch.toLowerCase(); let l = driverSearch ? drivers.filter(d => d.name?.toLowerCase().includes(q) || d.email?.toLowerCase().includes(q) || d.company?.toLowerCase().includes(q)) : drivers; return showActiveDrivers ? l.filter(d => d.is_active) : l }
  const fF = () => { const q = facilitySearch.toLowerCase(); let l = facilitySearch ? facilities.filter(f => f.name?.toLowerCase().includes(q) || f.address?.toLowerCase().includes(q)) : facilities; return showActiveFacilities ? l.filter(f => f.is_active) : l }

  const tabSt = (t: string): React.CSSProperties => ({
    flex:1, padding:'8px 2px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold', fontSize:'10px',
    background: activeTab === t ? '#C9A227' : '#1e2535',
    color: activeTab === t ? '#0f1117' : '#888', fontFamily:'Arial'
  })
  const inp: React.CSSProperties = {
    display:'block', width:'100%', marginTop:'6px', marginBottom:'10px',
    padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055',
    borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box', outline:'none'
  }
  const bGold: React.CSSProperties = { padding:'10px 14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }
  const bGray: React.CSSProperties = { padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }
  const bRed: React.CSSProperties = { padding:'6px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }
  const bGrn: React.CSSProperties = { padding:'6px 10px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }
  const lbl: React.CSSProperties = { color:'#aaa', fontSize:'10px', textTransform:'uppercase' as const }
  const badge = (active: boolean) => ({ background: active ? '#1a3a1a' : '#3a1a1a', color: active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' as const })
  const editBtn: React.CSSProperties = { flex:1, padding:'6px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }
  const card: React.CSSProperties = { background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }
  const addCard: React.CSSProperties = { background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }
  const editCard: React.CSSProperties = { background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }
  const pInp: React.CSSProperties = { ...inp, marginTop:0, marginBottom:0, padding:'4px 6px', fontSize:'11px', width:'100%' }
  const pCell = (field: string, def: number) => (
    <div style={{ display:'flex', alignItems:'center', gap:'2px' }}>
      <span style={{ color:'#555', fontSize:'11px' }}>$</span>
      <input type="number" step="0.01" min="0"
        value={platformSettings[field] ?? def}
        onChange={e => setPlatformSettings((p: any) => ({ ...p, [field]: parseFloat(e.target.value) }))}
        style={pInp} />
    </div>
  )
  const iCell = <span style={{ color:'#555', fontSize:'11px', fontStyle:'italic', display:'block', textAlign:'center' as const }}>Incl.</span>
  const logoUploadBtn: React.CSSProperties = { background:'#1a1f2e', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', padding:'8px 14px', fontSize:'12px', cursor:'pointer', whiteSpace:'nowrap' as const, flexShrink:0, fontFamily:'Arial' }
  const logoField = (value: string, onChange: (url: string) => void, pathPrefix: string, slot: string) => (
    <div>
      <label style={lbl}>Logo URL — paste a URL or upload an image file</label>
      <div style={{ display:'flex', gap:'6px', alignItems:'center', marginTop:'6px', marginBottom:'4px' }}>
        <input value={value} onChange={e => onChange(e.target.value)} placeholder="https://..." style={{ ...inp, marginTop:0, marginBottom:0, flex:1 }} />
        <label style={logoUploadBtn}>
          ↑ Upload Logo
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style={{ display:'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f, pathPrefix, slot, onChange); e.target.value = '' }} />
        </label>
      </div>
      {logoUploadMsg[slot] && <p style={{ color: logoUploadMsg[slot].includes('fail') || logoUploadMsg[slot].includes('exceed') ? '#f44336' : logoUploadMsg[slot] === 'Uploading...' ? '#C9A227' : '#4caf50', fontSize:'11px', margin:'2px 0 4px' }}>{logoUploadMsg[slot]}</p>}
      {value && <img src={value} alt="Logo preview" style={{ maxHeight:'60px', objectFit:'contain', display:'block', marginTop:'6px', marginBottom:'12px', borderRadius:'4px', border:'1px solid #2a2f3d' }} />}
      {!value && <div style={{ marginBottom:'12px' }} />}
    </div>
  )
  const tierBaseMap: Record<string, string> = {
    'enforcement:starter': 'price_enforcement_starter_base',
    'enforcement:growth': 'price_enforcement_growth_base',
    'enforcement:legacy': 'price_enforcement_legacy_base',
    'pm:essential': 'price_pm_essential_base',
    'pm:professional': 'price_pm_professional_base',
    'pm:enterprise': 'price_pm_enterprise_base',
  }
  const getCompanyPrice = (c: any) => {
    const key = `${c.tier_type || 'enforcement'}:${c.tier || 'legacy'}`
    const field = tierBaseMap[key]
    if (!field) return null
    const val = platformSettings[field]
    return val != null ? `from $${Number(val).toFixed(0)}/mo` : null
  }

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'700px', margin:'0 auto' }}>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'20px' }}>
          <div>
            <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>ShieldMyLot</h1>
            <p style={{ color:'#888', fontSize:'12px', margin:'4px 0 0' }}>Super Admin · {adminEmail}</p>
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
            style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px' }}>
            Sign Out
          </button>
        </div>

        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'16px' }}>
          {[['companies','Companies'],['properties','Properties'],['users','Users & Roles'],['drivers','Drivers'],['facilities','Facilities'],['auditlog','Audit Log'],['platform','Platform'],['analytics','Analytics']].map(([k,l]) => (
            <button key={k} style={tabSt(k)} onClick={() => setActiveTab(k)}>{l}</button>
          ))}
        </div>

        {/* ── COMPANIES ── */}
        {activeTab === 'companies' && (
          <div>
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={companySearch} onChange={e => setCompanySearch(e.target.value)} placeholder="Search companies..." style={{ ...inp, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveCompanies(s => !s)} style={{ padding:'4px 10px', background: showActiveCompanies ? '#1a1f2e' : '#111', color: showActiveCompanies ? '#C9A227' : '#555', border:`1px solid ${showActiveCompanies ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveCompanies ? '● Active Only' : '○ Show All'}</button>
            </div>
            <button onClick={() => { setShowAddCompany(!showAddCompany); setEditingCompany(null) }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Company</button>

            {showAddCompany && !editingCompany && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Company</p>
                <label style={lbl}>Name *</label><input value={newCompany.name} onChange={e => setNewCompany({...newCompany, name: e.target.value})} style={inp} />
                <label style={lbl}>Display Name</label><input value={newCompany.display_name} onChange={e => setNewCompany({...newCompany, display_name: e.target.value})} placeholder="Shown to users in app" style={inp} />
                {logoField(newCompany.logo_url, url => setNewCompany({...newCompany, logo_url: url}), `companies/${(newCompany.name || 'company').toLowerCase().replace(/\s+/g,'-')}-logo`, 'new_company')}
                <label style={lbl}>Address</label><input value={newCompany.address} onChange={e => setNewCompany({...newCompany, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={newCompany.phone} onChange={e => setNewCompany({...newCompany, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={newCompany.email} onChange={e => setNewCompany({...newCompany, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Support Phone</label><input value={newCompany.support_phone} onChange={e => setNewCompany({...newCompany, support_phone: e.target.value})} placeholder="346-428-7864" style={inp} />
                <label style={lbl}>Support Email</label><input value={newCompany.support_email} onChange={e => setNewCompany({...newCompany, support_email: e.target.value})} placeholder="support@company.com" style={inp} />
                <label style={lbl}>Support Website</label><input value={newCompany.support_website} onChange={e => setNewCompany({...newCompany, support_website: e.target.value})} placeholder="company.com" style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div>
                    <label style={lbl}>Account Type</label>
                    <select value={newCompany.tier_type} onChange={e => setNewCompany({...newCompany, tier_type: e.target.value, tier: e.target.value === 'enforcement' ? 'legacy' : 'essential'})} style={inp}>
                      <option value="enforcement">Enforcement</option>
                      <option value="property_management">Property Management</option>
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Service Tier</label>
                    <select value={newCompany.tier} onChange={e => setNewCompany({...newCompany, tier: e.target.value})} style={inp}>
                      {newCompany.tier_type === 'enforcement'
                        ? <><option value="starter">Starter</option><option value="growth">Growth</option><option value="legacy">Legacy</option></>
                        : <><option value="essential">Essential</option><option value="professional">Professional</option><option value="enterprise">Enterprise</option></>
                      }
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ ...lbl, display:'flex', alignItems:'center', gap:'8px' }}>
                    Color Theme
                    <span style={{ width:'14px', height:'14px', borderRadius:'50%', background:({'gold':'#C9A227','blue':'#1565C0','green':'#2E7D32','grey':'#546E7A','red':'#B71C1C'} as Record<string,string>)[newCompany.theme] || '#C9A227', display:'inline-block', border:'1px solid rgba(255,255,255,0.2)', flexShrink:0 }} />
                  </label>
                  <select value={newCompany.theme} onChange={e => setNewCompany({...newCompany, theme: e.target.value})} style={inp}>
                    <option value="gold">Gold (Default)</option>
                    <option value="blue">Ocean Blue</option>
                    <option value="green">Forest Green</option>
                    <option value="grey">Steel Grey</option>
                    <option value="red">Crimson</option>
                  </select>
                </div>
                <label style={lbl}>Active</label>
                <select value={newCompany.is_active ? 'true' : 'false'} onChange={e => setNewCompany({...newCompany, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addCompany} style={{ ...bGold, flex:1 }}>Add Company</button>
                  <button onClick={() => setShowAddCompany(false)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingCompany && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingCompany.name}</p>
                <label style={lbl}>Name *</label><input value={editingCompany.name} onChange={e => setEditingCompany({...editingCompany, name: e.target.value})} style={inp} />
                <label style={lbl}>Display Name</label><input value={editingCompany.display_name || ''} onChange={e => setEditingCompany({...editingCompany, display_name: e.target.value})} placeholder="Shown to users in app" style={inp} />
                {logoField(editingCompany.logo_url || '', url => setEditingCompany({...editingCompany, logo_url: url}), `companies/${(editingCompany.name || 'company').toLowerCase().replace(/\s+/g,'-')}-logo`, 'edit_company')}
                <label style={lbl}>Address</label><input value={editingCompany.address || ''} onChange={e => setEditingCompany({...editingCompany, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={editingCompany.phone || ''} onChange={e => setEditingCompany({...editingCompany, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={editingCompany.email || ''} onChange={e => setEditingCompany({...editingCompany, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Support Phone</label><input value={editingCompany.support_phone || ''} onChange={e => setEditingCompany({...editingCompany, support_phone: e.target.value})} placeholder="346-428-7864" style={inp} />
                <label style={lbl}>Support Email</label><input value={editingCompany.support_email || ''} onChange={e => setEditingCompany({...editingCompany, support_email: e.target.value})} placeholder="support@company.com" style={inp} />
                <label style={lbl}>Support Website</label><input value={editingCompany.support_website || ''} onChange={e => setEditingCompany({...editingCompany, support_website: e.target.value})} placeholder="company.com" style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div>
                    <label style={lbl}>Account Type</label>
                    <select value={editingCompany.tier_type || 'enforcement'} onChange={e => setEditingCompany({...editingCompany, tier_type: e.target.value, tier: e.target.value === 'enforcement' ? 'legacy' : 'essential'})} style={inp}>
                      <option value="enforcement">Enforcement</option>
                      <option value="property_management">Property Management</option>
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Service Tier</label>
                    <select value={editingCompany.tier || 'legacy'} onChange={e => setEditingCompany({...editingCompany, tier: e.target.value})} style={inp}>
                      {(editingCompany.tier_type || 'enforcement') === 'enforcement'
                        ? <><option value="starter">Starter</option><option value="growth">Growth</option><option value="legacy">Legacy</option></>
                        : <><option value="essential">Essential</option><option value="professional">Professional</option><option value="enterprise">Enterprise</option></>
                      }
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ ...lbl, display:'flex', alignItems:'center', gap:'8px' }}>
                    Color Theme
                    <span style={{ width:'14px', height:'14px', borderRadius:'50%', background:({'gold':'#C9A227','blue':'#1565C0','green':'#2E7D32','grey':'#546E7A','red':'#B71C1C'} as Record<string,string>)[editingCompany.theme || 'gold'] || '#C9A227', display:'inline-block', border:'1px solid rgba(255,255,255,0.2)', flexShrink:0 }} />
                  </label>
                  <select value={editingCompany.theme || 'gold'} onChange={e => setEditingCompany({...editingCompany, theme: e.target.value})} style={inp}>
                    <option value="gold">Gold (Default)</option>
                    <option value="blue">Ocean Blue</option>
                    <option value="green">Forest Green</option>
                    <option value="grey">Steel Grey</option>
                    <option value="red">Crimson</option>
                  </select>
                </div>
                <label style={lbl}>Active</label>
                <select value={editingCompany.is_active ? 'true' : 'false'} onChange={e => setEditingCompany({...editingCompany, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveCompany} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingCompany(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fC().map((c, i) => (
              <div key={i} style={{...card, opacity: !showActiveCompanies && !c.is_active ? 0.5 : 1}}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{c.name}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</p>
                    {(c.tier || c.tier_type) && (
                      <div style={{ display:'flex', gap:'4px', marginTop:'4px', flexWrap:'wrap' as const, alignItems:'center' }}>
                        {c.tier_type && <span style={{ fontSize:'9px', padding:'1px 6px', borderRadius:'10px', background: c.tier_type === 'enforcement' ? '#1a1230' : '#0e1a2a', color: c.tier_type === 'enforcement' ? '#b39ddb' : '#4fc3f7', border:`1px solid ${c.tier_type === 'enforcement' ? '#7c4dff' : '#0288d1'}`, textTransform:'uppercase' as const, letterSpacing:'0.05em', fontWeight:'bold' }}>{c.tier_type === 'enforcement' ? 'Enforcement' : 'Property Mgmt'}</span>}
                        {c.tier && <span style={{ fontSize:'9px', padding:'1px 6px', borderRadius:'10px', background:'#1a1f0e', color:'#C9A227', border:'1px solid #C9A227', textTransform:'uppercase' as const, letterSpacing:'0.05em', fontWeight:'bold' }}>{c.tier}</span>}
                        {getCompanyPrice(c) && <span style={{ color:'#555', fontSize:'11px' }}>{getCompanyPrice(c)}</span>}
                      </div>
                    )}
                  </div>
                  <span style={badge(c.is_active)}>{c.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                {c.address && <p style={{ color:'#555', fontSize:'11px', margin:'0 0 10px' }}>{c.address}</p>}
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingCompany({...c}); setShowAddCompany(false) }} style={editBtn}>Edit</button>
                  {c.is_active ? <button onClick={() => toggleCompany(c, false)} style={bRed}>Deactivate</button>
                               : <button onClick={() => toggleCompany(c, true)} style={bGrn}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PROPERTIES ── */}
        {activeTab === 'properties' && (
          <div>
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={propertySearch} onChange={e => setPropertySearch(e.target.value)} placeholder="Search properties..." style={{ ...inp, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveProperties(s => !s)} style={{ padding:'4px 10px', background: showActiveProperties ? '#1a1f2e' : '#111', color: showActiveProperties ? '#C9A227' : '#555', border:`1px solid ${showActiveProperties ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveProperties ? '● Active Only' : '○ Show All'}</button>
            </div>
            <button onClick={() => { setShowAddProperty(!showAddProperty); setEditingProperty(null) }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Property</button>

            {showAddProperty && !editingProperty && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Property</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Property Name *</label><input value={newProperty.name} onChange={e => setNewProperty({...newProperty, name: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={lbl}>Company</label>
                    <select value={newProperty.company} onChange={e => setNewProperty({...newProperty, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Address</label><input value={newProperty.address} onChange={e => setNewProperty({...newProperty, address: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>City</label><input value={newProperty.city} onChange={e => setNewProperty({...newProperty, city: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>State</label><input value={newProperty.state} onChange={e => setNewProperty({...newProperty, state: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Zip</label><input value={newProperty.zip} onChange={e => setNewProperty({...newProperty, zip: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Total Spaces</label><input type="number" value={newProperty.total_spaces} onChange={e => setNewProperty({...newProperty, total_spaces: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>PM Name</label><input value={newProperty.pm_name} onChange={e => setNewProperty({...newProperty, pm_name: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Phone</label><input value={newProperty.pm_phone} onChange={e => setNewProperty({...newProperty, pm_phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Email</label><input value={newProperty.pm_email} onChange={e => setNewProperty({...newProperty, pm_email: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Active</label><select value={newProperty.is_active ? 'true' : 'false'} onChange={e => setNewProperty({...newProperty, is_active: e.target.value === 'true'})} style={inp}><option value="true">Yes</option><option value="false">No</option></select></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addProperty} style={{ ...bGold, flex:1 }}>Add Property</button>
                  <button onClick={() => setShowAddProperty(false)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingProperty && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingProperty.name}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Property Name *</label><input value={editingProperty.name || ''} onChange={e => setEditingProperty({...editingProperty, name: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={lbl}>Company</label>
                    <select value={editingProperty.company || ''} onChange={e => setEditingProperty({...editingProperty, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Address</label><input value={editingProperty.address || ''} onChange={e => setEditingProperty({...editingProperty, address: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>City</label><input value={editingProperty.city || ''} onChange={e => setEditingProperty({...editingProperty, city: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>State</label><input value={editingProperty.state || ''} onChange={e => setEditingProperty({...editingProperty, state: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Zip</label><input value={editingProperty.zip || ''} onChange={e => setEditingProperty({...editingProperty, zip: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Total Spaces</label><input type="number" value={editingProperty.total_spaces || ''} onChange={e => setEditingProperty({...editingProperty, total_spaces: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>PM Name</label><input value={editingProperty.pm_name || ''} onChange={e => setEditingProperty({...editingProperty, pm_name: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Phone</label><input value={editingProperty.pm_phone || ''} onChange={e => setEditingProperty({...editingProperty, pm_phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Email</label><input value={editingProperty.pm_email || ''} onChange={e => setEditingProperty({...editingProperty, pm_email: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Active</label><select value={editingProperty.is_active ? 'true' : 'false'} onChange={e => setEditingProperty({...editingProperty, is_active: e.target.value === 'true'})} style={inp}><option value="true">Yes</option><option value="false">No</option></select></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveProperty} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingProperty(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fP().map((p, i) => (
              <div key={i} style={{...card, opacity: !showActiveProperties && !p.is_active ? 0.5 : 1}}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{p.name}</p>
                    <p style={{ color:'#C9A227', fontSize:'11px', margin:'3px 0 0' }}>{p.company || 'No company'}</p>
                  </div>
                  <span style={badge(p.is_active)}>{p.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Address</span><br/><span style={{ color:'#aaa' }}>{[p.address, p.city, p.state].filter(Boolean).join(', ') || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Spaces</span><br/><span style={{ color:'#aaa' }}>{p.total_spaces || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>PM</span><br/><span style={{ color:'#aaa' }}>{p.pm_name || '—'}</span></div>
                </div>
                <div style={{ display:'flex', gap:'6px' }}>
                  {p.is_active
                    ? <button onClick={() => toggleProperty(p, false)} style={{ ...bRed, flex:1 }}>Deactivate</button>
                    : <button onClick={() => toggleProperty(p, true)} style={{ ...bGrn, flex:1 }}>Activate</button>}
                  <button onClick={() => { setEditingProperty({...p}); setShowAddProperty(false) }} style={{ ...editBtn, flex:1 }}>Edit</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── USERS & ROLES ── */}
        {activeTab === 'users' && (
          <div>
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={userSearch} onChange={e => setUserSearch(e.target.value)} placeholder="Search email, role, company..." style={{ ...inp, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveUsers(s => !s)} style={{ padding:'4px 10px', background: showActiveUsers ? '#1a1f2e' : '#111', color: showActiveUsers ? '#C9A227' : '#555', border:`1px solid ${showActiveUsers ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveUsers ? '● Active Only' : '○ Show All'}</button>
            </div>
            <button onClick={() => { setShowAddUser(!showAddUser); setUserMsg('') }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add User</button>

            {showAddUser && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New User Account</p>
                <label style={lbl}>Email *</label>
                <input type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} placeholder="user@example.com" style={inp} />
                <label style={lbl}>Password *</label>
                <input type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} placeholder="Min 8 characters" style={inp} />
                <label style={lbl}>Role</label>
                <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})} style={inp}>
                  {['admin','company_admin','manager','driver','resident'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <label style={lbl}>Company</label>
                <select value={newUser.company} onChange={e => setNewUser({...newUser, company: e.target.value})} style={inp}>
                  <option value=''>None</option>
                  {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                </select>
                <label style={lbl}>Property (pipe-separated for multiple)</label>
                <input value={newUser.property} onChange={e => setNewUser({...newUser, property: e.target.value})} placeholder="Property A|Property B" style={inp} />
                {userMsg && (
                  <div style={{ background: userMsg.includes('success') ? '#1a3a1a' : '#3a1a1a', border:`1px solid ${userMsg.includes('success') ? '#2e7d32' : '#b71c1c'}`, borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                    <p style={{ color: userMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0' }}>{userMsg}</p>
                  </div>
                )}
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addUser} style={{ ...bGold, flex:1 }}>Create User</button>
                  <button onClick={() => { setShowAddUser(false); setUserMsg('') }} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {/* ── BULK UPLOAD ── */}
            <button
              onClick={() => { setShowBulkUpload(!showBulkUpload); setBulkRows([]); setBulkResults([]) }}
              style={{ ...bGray, width:'100%', marginBottom:'12px', color:'#C9A227', border:'1px solid #C9A227' }}
            >
              {showBulkUpload ? '▲ Hide Bulk Upload' : '↑ Bulk Upload Users'}
            </button>

            {showBulkUpload && (
              <div style={{ ...addCard, marginBottom:'16px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Bulk Upload Users</p>
                <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px', lineHeight:'1.6' }}>
                  Download the template, fill it in, then upload to create multiple users at once.
                </p>

                <button onClick={downloadTemplate} style={{ ...bGray, fontSize:'12px', marginBottom:'14px' }}>↓ Download Template</button>

                <label style={lbl}>Upload CSV or Excel (.xlsx)</label>
                <input
                  type="file" accept=".csv,.xlsx,.xls"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleBulkFile(f) }}
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', color:'#aaa', fontSize:'12px', boxSizing:'border-box' }}
                />

                {/* Preview table */}
                {bulkRows.length > 0 && !bulkProcessing && bulkResults.length === 0 && (
                  <>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 8px' }}>
                      {bulkRows.length} row{bulkRows.length !== 1 ? 's' : ''} found — preview:
                    </p>
                    <div style={{ overflowX:'auto', marginBottom:'12px', background:'#0f1117', borderRadius:'6px', border:'1px solid #2a2f3d' }}>
                      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'11px' }}>
                        <thead>
                          <tr style={{ borderBottom:'1px solid #2a2f3d' }}>
                            {['email','role','company','property','name'].map(h => (
                              <th key={h} style={{ color:'#C9A227', textAlign:'left', padding:'6px 8px', textTransform:'uppercase', fontSize:'10px', whiteSpace:'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {bulkRows.slice(0, 10).map((row, i) => (
                            <tr key={i} style={{ borderBottom:'1px solid #1e2535' }}>
                              {['email','role','company','property','name'].map(h => (
                                <td key={h} style={{ color:'#aaa', padding:'5px 8px', maxWidth:'140px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{row[h] || '—'}</td>
                              ))}
                            </tr>
                          ))}
                          {bulkRows.length > 10 && (
                            <tr>
                              <td colSpan={5} style={{ color:'#555', padding:'5px 8px', fontSize:'10px' }}>
                                …and {bulkRows.length - 10} more
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <button onClick={processBulkUsers} style={{ ...bGold, width:'100%' }}>
                      Create All {bulkRows.length} Users
                    </button>
                  </>
                )}

                {/* Progress bar */}
                {bulkProcessing && (
                  <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'16px', textAlign:'center' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 10px' }}>
                      Processing {bulkProgress.current} of {bulkProgress.total}…
                    </p>
                    <div style={{ background:'#1e2535', borderRadius:'4px', height:'6px', overflow:'hidden' }}>
                      <div style={{
                        width: `${Math.round((bulkProgress.current / bulkProgress.total) * 100)}%`,
                        height:'100%', background:'#C9A227', borderRadius:'4px', transition:'width 0.2s'
                      }} />
                    </div>
                  </div>
                )}

                {/* Results */}
                {bulkResults.length > 0 && !bulkProcessing && (
                  <>
                    <div style={{ display:'flex', gap:'8px', marginBottom:'10px' }}>
                      <div style={{ flex:1, background:'#1a3a1a', border:'1px solid #2e7d32', borderRadius:'8px', padding:'10px', textAlign:'center' }}>
                        <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'18px', margin:'0' }}>{bulkResults.filter(r => r.status === 'success').length}</p>
                        <p style={{ color:'#4caf50', fontSize:'11px', margin:'2px 0 0' }}>Created</p>
                      </div>
                      <div style={{ flex:1, background: bulkResults.some(r => r.status === 'error') ? '#3a1a1a' : '#1e2535', border:`1px solid ${bulkResults.some(r => r.status === 'error') ? '#b71c1c' : '#2a2f3d'}`, borderRadius:'8px', padding:'10px', textAlign:'center' }}>
                        <p style={{ color: bulkResults.some(r => r.status === 'error') ? '#f44336' : '#555', fontWeight:'bold', fontSize:'18px', margin:'0' }}>{bulkResults.filter(r => r.status === 'error').length}</p>
                        <p style={{ color: bulkResults.some(r => r.status === 'error') ? '#f44336' : '#555', fontSize:'11px', margin:'2px 0 0' }}>Failed</p>
                      </div>
                    </div>

                    <div style={{ overflowX:'auto', marginBottom:'10px', background:'#0f1117', borderRadius:'6px', border:'1px solid #2a2f3d', maxHeight:'260px', overflowY:'auto' }}>
                      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'11px' }}>
                        <thead>
                          <tr style={{ borderBottom:'1px solid #2a2f3d' }}>
                            {['Email','Role','Status','Note'].map(h => (
                              <th key={h} style={{ color:'#C9A227', textAlign:'left', padding:'6px 8px', textTransform:'uppercase', fontSize:'10px', whiteSpace:'nowrap', position:'sticky', top:0, background:'#0f1117' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {bulkResults.map((r, i) => (
                            <tr key={i} style={{ borderBottom:'1px solid #1e2535' }}>
                              <td style={{ color:'#aaa', padding:'5px 8px', maxWidth:'180px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.email}</td>
                              <td style={{ color:'#aaa', padding:'5px 8px', whiteSpace:'nowrap' }}>{r.role}</td>
                              <td style={{ padding:'5px 8px', whiteSpace:'nowrap' }}>
                                <span style={{ color: r.status === 'success' ? '#4caf50' : '#f44336', fontWeight:'bold' }}>
                                  {r.status === 'success' ? '✓' : '✗'} {r.status}
                                </span>
                              </td>
                              <td style={{ color:'#555', padding:'5px 8px', fontSize:'10px' }}>
                                {r.error || (r.status === 'success' ? `Temp pw: ${r.email.split('@')[0]}!A1` : '')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={downloadResults} style={{ ...bGray, flex:1, fontSize:'12px' }}>↓ Download Results</button>
                      <button onClick={() => { setBulkRows([]); setBulkResults([]); setBulkProgress({ current:0, total:0 }) }} style={{ ...bGray, flex:1, fontSize:'12px' }}>Start Over</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {([
              ['admin', 'Admins'],
              ['company_admin', 'Company Admins'],
              ['manager', 'Property Managers'],
              ['leasing_agent', 'Leasing Agents'],
              ['driver', 'Drivers'],
              ['resident', 'Residents'],
            ] as [string, string][]).map(([role, label]) => {
              const groupUsers = fU().filter(u => u.role === role)
              if (groupUsers.length === 0) return null
              const collapsed = collapsedGroups.has(role)
              return (
                <div key={role} style={{ marginBottom:'8px' }}>
                  <div onClick={() => toggleGroup(role)} style={{ background:'#1a1f2e', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 14px', marginBottom:'6px', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                      <span style={{ color:'#aaa', fontSize:'12px' }}>{collapsed ? '▶' : '▼'}</span>
                      <span style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px' }}>{label}</span>
                    </div>
                    <span style={{ background:'#C9A227', color:'#0f1117', borderRadius:'10px', fontSize:'10px', padding:'2px 8px', fontWeight:'bold' }}>{groupUsers.length}</span>
                  </div>
                  {!collapsed && groupUsers.map((u, i) => (
                    <div key={i} style={{ ...card, marginBottom:'6px' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                        <div>
                          <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{u.email}</p>
                          <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{u.company || 'No company'}</p>
                        </div>
                        <span style={{ background:'#1e2535', color:'#C9A227', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold', border:'1px solid #C9A227' }}>{u.role}</span>
                      </div>
                      {u.property && <p style={{ color:'#555', fontSize:'11px', margin:'6px 0 0' }}>Properties: {u.property}</p>}
                      <div style={{ marginTop:'8px' }}>
                        <button onClick={() => { setResetPwTarget(resetPwTarget === u.email ? null : u.email); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }}
                          style={{ padding:'4px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          {resetPwTarget === u.email ? 'Cancel' : 'Reset Password'}
                        </button>
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
                </div>
              )
            })}
          </div>
        )}

        {/* ── DRIVERS ── */}
        {activeTab === 'drivers' && (
          <div>
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={driverSearch} onChange={e => setDriverSearch(e.target.value)} placeholder="Search name, email, company..." style={{ ...inp, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveDrivers(s => !s)} style={{ padding:'4px 10px', background: showActiveDrivers ? '#1a1f2e' : '#111', color: showActiveDrivers ? '#C9A227' : '#555', border:`1px solid ${showActiveDrivers ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveDrivers ? '● Active Only' : '○ Show All'}</button>
            </div>
            <button onClick={() => { setShowAddDriver(!showAddDriver); setEditingDriver(null); setDriverMsg('') }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Driver</button>

            {showAddDriver && !editingDriver && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Driver</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Full Name *</label><input value={newDriver.name} onChange={e => setNewDriver({...newDriver, name: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Email *</label><input value={newDriver.email} onChange={e => setNewDriver({...newDriver, email: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Phone</label><input value={newDriver.phone} onChange={e => setNewDriver({...newDriver, phone: e.target.value})} style={inp} /></div>
                  <div>
                    <label style={lbl}>Company</label>
                    <select value={newDriver.company} onChange={e => setNewDriver({...newDriver, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div><label style={lbl}>Operator License</label><input value={newDriver.operator_license} onChange={e => setNewDriver({...newDriver, operator_license: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={lbl}>Assigned Properties</label>
                    {(() => {
                      const dProps = newDriver.company ? properties.filter((p: any) => p.company === newDriver.company) : []
                      return (
                        <div style={{ marginTop:'6px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px' }}>
                          {!newDriver.company ? (
                            <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Select a company first to see available properties.</p>
                          ) : dProps.length === 0 ? (
                            <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No properties found for this company.</p>
                          ) : (
                            <>
                              <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer', borderBottom:'1px solid #2a2f3d', marginBottom:'4px' }}>
                                <input type="checkbox"
                                  checked={newDriver.assigned_properties.length === dProps.length}
                                  onChange={e => setNewDriver({...newDriver, assigned_properties: e.target.checked ? dProps.map((p: any) => p.name) : []})}
                                  style={{ accentColor:'#C9A227', cursor:'pointer' }}
                                />
                                <span style={{ color:'#C9A227', fontSize:'12px', fontWeight:'bold' }}>Select All</span>
                              </label>
                              {dProps.map((p: any, i: number) => (
                                <label key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer' }}>
                                  <input type="checkbox"
                                    checked={newDriver.assigned_properties.includes(p.name)}
                                    onChange={e => {
                                      if (e.target.checked) setNewDriver({...newDriver, assigned_properties: [...newDriver.assigned_properties, p.name]})
                                      else setNewDriver({...newDriver, assigned_properties: newDriver.assigned_properties.filter((n: string) => n !== p.name)})
                                    }}
                                    style={{ accentColor:'#C9A227', cursor:'pointer' }}
                                  />
                                  <span style={{ color:'#aaa', fontSize:'12px' }}>{p.name}</span>
                                </label>
                              ))}
                            </>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
                {driverMsg && (
                  <div style={{ background: driverMsg.includes('created') ? '#1a3a1a' : '#3a1a1a', border:`1px solid ${driverMsg.includes('created') ? '#2e7d32' : '#b71c1c'}`, borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                    <p style={{ color: driverMsg.includes('created') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0', wordBreak:'break-all' }}>{driverMsg}</p>
                  </div>
                )}
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addDriver} style={{ ...bGold, flex:1 }}>Add Driver</button>
                  <button onClick={() => { setShowAddDriver(false); setDriverMsg('') }} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingDriver && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingDriver.name}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Full Name</label><input value={editingDriver.name || ''} onChange={e => setEditingDriver({...editingDriver, name: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Phone</label><input value={editingDriver.phone || ''} onChange={e => setEditingDriver({...editingDriver, phone: e.target.value})} style={inp} /></div>
                  <div>
                    <label style={lbl}>Company</label>
                    <select value={editingDriver.company || ''} onChange={e => setEditingDriver({...editingDriver, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div><label style={lbl}>Operator License</label><input value={editingDriver.operator_license || ''} onChange={e => setEditingDriver({...editingDriver, operator_license: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Active</label><select value={editingDriver.is_active ? 'true' : 'false'} onChange={e => setEditingDriver({...editingDriver, is_active: e.target.value === 'true'})} style={inp}><option value="true">Yes</option><option value="false">No</option></select></div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={lbl}>Assigned Properties</label>
                    {(() => {
                      const eProps = editingDriver.company ? properties.filter((p: any) => p.company === editingDriver.company) : []
                      return (
                        <div style={{ marginTop:'6px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px' }}>
                          {!editingDriver.company ? (
                            <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Select a company first to see available properties.</p>
                          ) : eProps.length === 0 ? (
                            <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No properties found for this company.</p>
                          ) : (
                            <>
                              <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer', borderBottom:'1px solid #2a2f3d', marginBottom:'4px' }}>
                                <input type="checkbox"
                                  checked={(editingDriver.assigned_properties || []).length === eProps.length}
                                  onChange={e => setEditingDriver({...editingDriver, assigned_properties: e.target.checked ? eProps.map((p: any) => p.name) : []})}
                                  style={{ accentColor:'#C9A227', cursor:'pointer' }}
                                />
                                <span style={{ color:'#C9A227', fontSize:'12px', fontWeight:'bold' }}>Select All</span>
                              </label>
                              {eProps.map((p: any, i: number) => (
                                <label key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer' }}>
                                  <input type="checkbox"
                                    checked={(editingDriver.assigned_properties || []).includes(p.name)}
                                    onChange={e => {
                                      const cur: string[] = editingDriver.assigned_properties || []
                                      if (e.target.checked) setEditingDriver({...editingDriver, assigned_properties: [...cur, p.name]})
                                      else setEditingDriver({...editingDriver, assigned_properties: cur.filter((n: string) => n !== p.name)})
                                    }}
                                    style={{ accentColor:'#C9A227', cursor:'pointer' }}
                                  />
                                  <span style={{ color:'#aaa', fontSize:'12px' }}>{p.name}</span>
                                </label>
                              ))}
                            </>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveDriver} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingDriver(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fD().map((d, i) => (
              <div key={i} style={{...card, opacity: !showActiveDrivers && !d.is_active ? 0.5 : 1}}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{d.name}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{d.email}</p>
                  </div>
                  <span style={badge(d.is_active)}>{d.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Company</span><br/><span style={{ color:'#aaa' }}>{d.company || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>License</span><br/><span style={{ color:'#aaa' }}>{d.operator_license || '—'}</span></div>
                  {d.assigned_properties?.length > 0 && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Properties</span><br/><span style={{ color:'#aaa' }}>{Array.isArray(d.assigned_properties) ? d.assigned_properties.join(', ') : d.assigned_properties}</span></div>}
                </div>
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingDriver({...d, assigned_properties: Array.isArray(d.assigned_properties) ? d.assigned_properties : (d.assigned_properties || '').split('|').map((p: string) => p.trim()).filter(Boolean)}); setShowAddDriver(false) }} style={editBtn}>Edit</button>
                  {d.is_active ? <button onClick={() => toggleDriver(d, false)} style={bRed}>Deactivate</button>
                               : <button onClick={() => toggleDriver(d, true)} style={bGrn}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── STORAGE FACILITIES ── */}
        {activeTab === 'facilities' && (
          <div>
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={facilitySearch} onChange={e => setFacilitySearch(e.target.value)} placeholder="Search facilities..." style={{ ...inp, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveFacilities(s => !s)} style={{ padding:'4px 10px', background: showActiveFacilities ? '#1a1f2e' : '#111', color: showActiveFacilities ? '#C9A227' : '#555', border:`1px solid ${showActiveFacilities ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveFacilities ? '● Active Only' : '○ Show All'}</button>
            </div>
            <button onClick={() => { setShowAddFacility(!showAddFacility); setEditingFacility(null) }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Storage Facility</button>

            {showAddFacility && !editingFacility && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Storage Facility</p>
                <label style={lbl}>Name *</label><input value={newFacility.name} onChange={e => setNewFacility({...newFacility, name: e.target.value})} style={inp} />
                <label style={lbl}>Address</label><input value={newFacility.address} onChange={e => setNewFacility({...newFacility, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={newFacility.phone} onChange={e => setNewFacility({...newFacility, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={newFacility.email} onChange={e => setNewFacility({...newFacility, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Active</label>
                <select value={newFacility.is_active ? 'true' : 'false'} onChange={e => setNewFacility({...newFacility, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addFacility} style={{ ...bGold, flex:1 }}>Add Facility</button>
                  <button onClick={() => setShowAddFacility(false)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingFacility && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingFacility.name}</p>
                <label style={lbl}>Name *</label><input value={editingFacility.name || ''} onChange={e => setEditingFacility({...editingFacility, name: e.target.value})} style={inp} />
                <label style={lbl}>Address</label><input value={editingFacility.address || ''} onChange={e => setEditingFacility({...editingFacility, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={editingFacility.phone || ''} onChange={e => setEditingFacility({...editingFacility, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={editingFacility.email || ''} onChange={e => setEditingFacility({...editingFacility, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Active</label>
                <select value={editingFacility.is_active ? 'true' : 'false'} onChange={e => setEditingFacility({...editingFacility, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveFacility} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingFacility(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fF().map((f, i) => (
              <div key={i} style={{...card, opacity: !showActiveFacilities && !f.is_active ? 0.5 : 1}}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{f.name}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{[f.phone, f.email].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <span style={badge(f.is_active)}>{f.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                {f.address && <p style={{ color:'#555', fontSize:'11px', margin:'0 0 10px' }}>{f.address}</p>}
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingFacility({...f}); setShowAddFacility(false) }} style={editBtn}>Edit</button>
                  {f.is_active ? <button onClick={() => toggleFacility(f, false)} style={bRed}>Deactivate</button>
                               : <button onClick={() => toggleFacility(f, true)} style={bGrn}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── AUDIT LOG ── */}
        {activeTab === 'auditlog' && (() => {
          const today = new Date(); today.setHours(0,0,0,0)
          const week = new Date(); week.setDate(week.getDate()-7)
          const month = new Date(); month.setMonth(month.getMonth()-1)
          const filtered = allAuditLogs.filter(log => {
            const d = new Date(log.created_at)
            const inPeriod = auditDateFilter === 'today' ? d >= today : auditDateFilter === 'week' ? d >= week : auditDateFilter === 'month' ? d >= month : true
            if (!inPeriod) return false
            if (!auditSearch) return true
            const q = auditSearch.toLowerCase()
            return (log.user_email || '').toLowerCase().includes(q) ||
              (log.action || '').toLowerCase().includes(q) ||
              (log.table_name || '').toLowerCase().includes(q) ||
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
              <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search email, action, table, values..." style={{ ...inp, marginBottom:'10px' }} />
              {!auditLoaded ? (
                <p style={{ color:'#555', fontSize:'13px', textAlign:'center', margin:'32px 0' }}>Loading...</p>
              ) : filtered.length === 0 ? (
                <div style={card}><p style={{ color:'#555', fontSize:'13px', margin:'0', textAlign:'center' }}>No audit entries for this period</p></div>
              ) : filtered.map((log, i) => {
                const vals = log.new_values ? Object.entries(log.new_values as Record<string,unknown>).map(([k,v]) => `${k}: ${v}`).join(' · ') : ''
                return (
                  <div key={i} style={card}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                      <span style={{ background:'#1e1800', color:'#C9A227', padding:'2px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', letterSpacing:'0.04em' }}>{log.action}</span>
                      <span style={{ color:'#888', fontSize:'10px' }}>{new Date(log.created_at).toLocaleString()}</span>
                    </div>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>{log.user_email} <span style={{ color:'#cccccc' }}>· {log.table_name}</span></p>
                    {log.record_id && <p style={{ color:'#555', fontSize:'10px', margin:'0 0 2px', fontFamily:'Courier New' }}>id: {log.record_id}</p>}
                    {vals && <p style={{ color:'#888', fontSize:'11px', margin:'0', fontFamily:'Courier New', wordBreak:'break-all' }}>{vals}</p>}
                  </div>
                )
              })}
            </div>
          )
        })()}

        {/* ── PLATFORM SETTINGS ── */}
        {activeTab === 'platform' && (
          <div>
            <p style={{ color:'#555', fontSize:'11px', margin:'0 0 16px', lineHeight:'1.6' }}>
              Global defaults applied to all companies unless overridden per company.
            </p>

            {platformMsg && (
              <div style={{ background: platformMsg.includes('Error') ? '#3a1a1a' : '#1a3a1a', border:`1px solid ${platformMsg.includes('Error') ? '#b71c1c' : '#2e7d32'}`, borderRadius:'8px', padding:'10px 14px', marginBottom:'14px' }}>
                <p style={{ color: platformMsg.includes('Error') ? '#f44336' : '#4caf50', fontSize:'12px', margin:'0' }}>{platformMsg}</p>
              </div>
            )}

            {/* Section A — Default Branding */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px' }}>Default Branding</p>
              <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>These defaults apply to all new companies unless overridden per company.</p>

              <label style={lbl}>Default Display Name</label>
              <input value={platformSettings.default_display_name || ''} onChange={e => setPlatformSettings({...platformSettings, default_display_name: e.target.value})} placeholder="A1 Wrecker, LLC" style={inp} />

              {logoField(platformSettings.default_logo_url || '', url => setPlatformSettings({...platformSettings, default_logo_url: url}), 'platform/logo', 'platform')}

              <div>
                <label style={{ ...lbl, display:'flex', alignItems:'center', gap:'8px' }}>
                  Default Color Theme
                  <span style={{ width:'14px', height:'14px', borderRadius:'50%', background:({'gold':'#C9A227','blue':'#1565C0','green':'#2E7D32','grey':'#546E7A','red':'#B71C1C'} as Record<string,string>)[platformSettings.default_theme || 'gold'] || '#C9A227', display:'inline-block', border:'1px solid rgba(255,255,255,0.2)', flexShrink:0 }} />
                </label>
                <select value={platformSettings.default_theme || 'gold'} onChange={e => setPlatformSettings({...platformSettings, default_theme: e.target.value})} style={inp}>
                  <option value="gold">Gold (Default)</option>
                  <option value="blue">Ocean Blue</option>
                  <option value="green">Forest Green</option>
                  <option value="grey">Steel Grey</option>
                  <option value="red">Crimson</option>
                </select>
              </div>

              <button onClick={savePlatformSettings} style={{ ...bGold, width:'100%', marginTop:'4px' }}>Save Branding Defaults</button>
            </div>

            {/* Section B — Default Support Info */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px' }}>Default Support Info</p>
              <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>Shown to residents and visitors when contacting support.</p>

              <label style={lbl}>Default Support Phone</label>
              <input value={platformSettings.default_support_phone || ''} onChange={e => setPlatformSettings({...platformSettings, default_support_phone: e.target.value})} placeholder="346-428-7864" style={inp} />

              <label style={lbl}>Default Support Email</label>
              <input value={platformSettings.default_support_email || ''} onChange={e => setPlatformSettings({...platformSettings, default_support_email: e.target.value})} placeholder="support@a1wreckerllc.net" style={inp} />

              <label style={lbl}>Default Support Website</label>
              <input value={platformSettings.default_support_website || ''} onChange={e => setPlatformSettings({...platformSettings, default_support_website: e.target.value})} placeholder="a1wreckerllc.net" style={inp} />

              <button onClick={savePlatformSettings} style={{ ...bGold, width:'100%', marginTop:'4px' }}>Save Support Defaults</button>
            </div>

            {/* Section C — Base Subscription Pricing */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px' }}>Base Subscription Pricing</p>
              <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>Hybrid model: base fee + per-property + per-driver. Changes apply to new signups only.</p>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px' }}>

                {/* Enforcement card */}
                <div style={{ background:'#1e2535', borderRadius:'8px', padding:'12px' }}>
                  <p style={{ color:'#b39ddb', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Enforcement Track</p>
                  {/* Column headers */}
                  <div style={{ display:'grid', gridTemplateColumns:'60px 1fr 1fr 1fr', gap:'4px', marginBottom:'6px' }}>
                    <div />
                    <p style={{ color:'#666', fontSize:'9px', textAlign:'center', margin:0, textTransform:'uppercase', letterSpacing:'0.05em' }}>Base</p>
                    <p style={{ color:'#666', fontSize:'9px', textAlign:'center', margin:0, textTransform:'uppercase', letterSpacing:'0.05em' }}>/ Prop</p>
                    <p style={{ color:'#666', fontSize:'9px', textAlign:'center', margin:0, textTransform:'uppercase', letterSpacing:'0.05em' }}>/ Driver</p>
                  </div>
                  {[
                    { label:'Starter', base:'price_enforcement_starter_base', defBase:99, prop:'price_enforcement_starter_per_property', defProp:15, drv:'price_enforcement_starter_per_driver', defDrv:10 },
                    { label:'Growth',  base:'price_enforcement_growth_base',  defBase:149, prop:'price_enforcement_growth_per_property',  defProp:12, drv:'price_enforcement_growth_per_driver',  defDrv:8 },
                    { label:'Legacy',  base:'price_enforcement_legacy_base',  defBase:199, prop:'price_enforcement_legacy_per_property',  defProp:10, drv:'price_enforcement_legacy_per_driver',  defDrv:6 },
                  ].map(t => (
                    <div key={t.label} style={{ display:'grid', gridTemplateColumns:'60px 1fr 1fr 1fr', gap:'4px', alignItems:'center', marginBottom:'6px' }}>
                      <span style={{ color:'#aaa', fontSize:'11px' }}>{t.label}</span>
                      <div style={{ display:'flex', alignItems:'center', gap:'1px' }}><span style={{ color:'#555', fontSize:'10px' }}>$</span><input type="number" step="0.01" min="0" value={platformSettings[t.base] ?? t.defBase} onChange={e => setPlatformSettings((p: any) => ({...p, [t.base]: parseFloat(e.target.value)}))} style={pInp} /></div>
                      <div style={{ display:'flex', alignItems:'center', gap:'1px' }}><span style={{ color:'#555', fontSize:'10px' }}>$</span><input type="number" step="0.01" min="0" value={platformSettings[t.prop] ?? t.defProp} onChange={e => setPlatformSettings((p: any) => ({...p, [t.prop]: parseFloat(e.target.value)}))} style={pInp} /></div>
                      <div style={{ display:'flex', alignItems:'center', gap:'1px' }}><span style={{ color:'#555', fontSize:'10px' }}>$</span><input type="number" step="0.01" min="0" value={platformSettings[t.drv] ?? t.defDrv} onChange={e => setPlatformSettings((p: any) => ({...p, [t.drv]: parseFloat(e.target.value)}))} style={pInp} /></div>
                    </div>
                  ))}
                </div>

                {/* PM card */}
                <div style={{ background:'#1e2535', borderRadius:'8px', padding:'12px' }}>
                  <p style={{ color:'#4fc3f7', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Property Mgmt Track</p>
                  {/* Column headers */}
                  <div style={{ display:'grid', gridTemplateColumns:'80px 1fr 1fr', gap:'4px', marginBottom:'6px' }}>
                    <div />
                    <p style={{ color:'#666', fontSize:'9px', textAlign:'center', margin:0, textTransform:'uppercase', letterSpacing:'0.05em' }}>Base</p>
                    <p style={{ color:'#666', fontSize:'9px', textAlign:'center', margin:0, textTransform:'uppercase', letterSpacing:'0.05em' }}>/ Prop</p>
                  </div>
                  {[
                    { label:'Essential',     base:'price_pm_essential_base',     defBase:79,  prop:'price_pm_essential_per_property',     defProp:20 },
                    { label:'Professional',  base:'price_pm_professional_base',  defBase:129, prop:'price_pm_professional_per_property',  defProp:15 },
                    { label:'Enterprise',    base:'price_pm_enterprise_base',    defBase:179, prop:'price_pm_enterprise_per_property',    defProp:10 },
                  ].map(t => (
                    <div key={t.label} style={{ display:'grid', gridTemplateColumns:'80px 1fr 1fr', gap:'4px', alignItems:'center', marginBottom:'6px' }}>
                      <span style={{ color:'#aaa', fontSize:'11px' }}>{t.label}</span>
                      <div style={{ display:'flex', alignItems:'center', gap:'1px' }}><span style={{ color:'#555', fontSize:'10px' }}>$</span><input type="number" step="0.01" min="0" value={platformSettings[t.base] ?? t.defBase} onChange={e => setPlatformSettings((p: any) => ({...p, [t.base]: parseFloat(e.target.value)}))} style={pInp} /></div>
                      <div style={{ display:'flex', alignItems:'center', gap:'1px' }}><span style={{ color:'#555', fontSize:'10px' }}>$</span><input type="number" step="0.01" min="0" value={platformSettings[t.prop] ?? t.defProp} onChange={e => setPlatformSettings((p: any) => ({...p, [t.prop]: parseFloat(e.target.value)}))} style={pInp} /></div>
                    </div>
                  ))}
                  <p style={{ color:'#555', fontSize:'9px', margin:'8px 0 0', fontStyle:'italic' }}>No per-driver fee — PM clients do not have drivers.</p>
                </div>
              </div>
            </div>

            {/* Monthly Bill Calculator */}
            {(() => {
              const isEnf = calcTrack === 'enforcement'
              const tiers = isEnf
                ? ['starter','growth','legacy']
                : ['essential','professional','enterprise']
              const safeCalcTier = tiers.includes(calcTier) ? calcTier : tiers[0]
              const baseKey = `price_${calcTrack}_${safeCalcTier}_base`
              const propKey = `price_${calcTrack}_${safeCalcTier}_per_property`
              const drvKey  = `price_${calcTrack}_${safeCalcTier}_per_driver`
              const defBases: Record<string,number> = { starter:99, growth:149, legacy:199, essential:79, professional:129, enterprise:179 }
              const defProps: Record<string,number>  = { starter:15, growth:12,  legacy:10,  essential:20, professional:15,  enterprise:10 }
              const defDrvs: Record<string,number>   = { starter:10, growth:8,   legacy:6 }
              const base   = Number(platformSettings[baseKey] ?? defBases[safeCalcTier] ?? 0)
              const perProp = Number(platformSettings[propKey]  ?? defProps[safeCalcTier]  ?? 0)
              const perDrv  = isEnf ? Number(platformSettings[drvKey] ?? defDrvs[safeCalcTier] ?? 0) : 0
              const propTotal = perProp * calcProperties
              const drvTotal  = isEnf ? perDrv * calcDrivers : 0
              const monthly   = base + propTotal + drvTotal
              const annual    = monthly * 10
              const fmt = (n: number) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
              return (
                <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px' }}>Monthly Bill Calculator</p>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>Estimate what a client should be charged based on their tier and usage.</p>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', marginBottom:'12px' }}>
                    <div>
                      <label style={lbl}>Track</label>
                      <select value={calcTrack} onChange={e => { setCalcTrack(e.target.value); setCalcTier(e.target.value === 'enforcement' ? 'starter' : 'essential') }} style={{ ...inp, marginTop:0, marginBottom:0 }}>
                        <option value="enforcement">Enforcement</option>
                        <option value="pm">Property Mgmt</option>
                      </select>
                    </div>
                    <div>
                      <label style={lbl}>Tier</label>
                      <select value={safeCalcTier} onChange={e => setCalcTier(e.target.value)} style={{ ...inp, marginTop:0, marginBottom:0 }}>
                        {tiers.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={lbl}>Properties</label>
                      <input type="number" min="1" value={calcProperties} onChange={e => setCalcProperties(Math.max(1, parseInt(e.target.value) || 1))} style={{ ...inp, marginTop:0, marginBottom:0 }} />
                    </div>
                    {isEnf && (
                      <div>
                        <label style={lbl}>Drivers</label>
                        <input type="number" min="0" value={calcDrivers} onChange={e => setCalcDrivers(Math.max(0, parseInt(e.target.value) || 0))} style={{ ...inp, marginTop:0, marginBottom:0 }} />
                      </div>
                    )}
                  </div>
                  <div style={{ background:'#0f1117', borderRadius:'8px', padding:'12px', fontFamily:'Courier New' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'4px' }}>
                      <span style={{ color:'#888', fontSize:'12px' }}>Base fee</span>
                      <span style={{ color:'#ccc', fontSize:'12px' }}>{fmt(base)}</span>
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'4px' }}>
                      <span style={{ color:'#888', fontSize:'12px' }}>Properties ({calcProperties})</span>
                      <span style={{ color:'#ccc', fontSize:'12px' }}>{fmt(propTotal)}</span>
                    </div>
                    {isEnf && (
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'4px' }}>
                        <span style={{ color:'#888', fontSize:'12px' }}>Drivers ({calcDrivers})</span>
                        <span style={{ color:'#ccc', fontSize:'12px' }}>{fmt(drvTotal)}</span>
                      </div>
                    )}
                    <div style={{ borderTop:'1px solid #2a2f3d', margin:'8px 0' }} />
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'4px' }}>
                      <span style={{ color:'#C9A227', fontSize:'13px', fontWeight:'bold' }}>Monthly total</span>
                      <span style={{ color:'#C9A227', fontSize:'13px', fontWeight:'bold' }}>{fmt(monthly)}</span>
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between' }}>
                      <span style={{ color:'#888', fontSize:'11px' }}>Annual total <span style={{ color:'#555' }}>(2 months free)</span></span>
                      <span style={{ color:'#aaa', fontSize:'11px' }}>{fmt(annual)}</span>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* Section D — À La Carte Add-on Pricing */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px' }}>À La Carte Add-on Pricing</p>
              <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>Add-on prices vary by base tier. Features marked Incl. are part of that tier and cannot be purchased separately.</p>

              {/* Enforcement add-ons table */}
              <p style={{ color:'#b39ddb', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 8px' }}>Enforcement Track Add-ons</p>
              <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr 1fr 1fr', gap:'6px', alignItems:'center', marginBottom:'16px' }}>
                <div />
                <p style={{ color:'#888', fontSize:'10px', textAlign:'center', margin:0, fontWeight:'bold' }}>Starter</p>
                <p style={{ color:'#888', fontSize:'10px', textAlign:'center', margin:0, fontWeight:'bold' }}>Growth</p>
                <p style={{ color:'#888', fontSize:'10px', textAlign:'center', margin:0, fontWeight:'bold' }}>Legacy</p>

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Live Support</p>
                {pCell('addon_enforcement_starter_live_support', 100)}
                {pCell('addon_enforcement_growth_live_support', 50)}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Analytics</p>
                {pCell('addon_enforcement_starter_analytics', 25)}
                {pCell('addon_enforcement_growth_analytics', 15)}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Camera Scan</p>
                {pCell('addon_enforcement_starter_camera_scan', 20)}
                {iCell}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Video Upload</p>
                {pCell('addon_enforcement_starter_video_upload', 15)}
                {pCell('addon_enforcement_growth_video_upload', 10)}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>White Label</p>
                {pCell('addon_enforcement_starter_white_label', 30)}
                {iCell}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Extra Property</p>
                {pCell('addon_enforcement_starter_extra_property', 10)}
                {pCell('addon_enforcement_growth_extra_property', 8)}
                {pCell('addon_enforcement_legacy_extra_property', 5)}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Extra Driver</p>
                {pCell('addon_enforcement_starter_extra_driver', 8)}
                {pCell('addon_enforcement_growth_extra_driver', 5)}
                {pCell('addon_enforcement_legacy_extra_driver', 3)}
              </div>

              {/* PM add-ons table */}
              <p style={{ color:'#4fc3f7', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 8px' }}>Property Mgmt Track Add-ons</p>
              <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr 1fr 1fr', gap:'6px', alignItems:'center', marginBottom:'16px' }}>
                <div />
                <p style={{ color:'#888', fontSize:'10px', textAlign:'center', margin:0, fontWeight:'bold' }}>Essential</p>
                <p style={{ color:'#888', fontSize:'10px', textAlign:'center', margin:0, fontWeight:'bold' }}>Professional</p>
                <p style={{ color:'#888', fontSize:'10px', textAlign:'center', margin:0, fontWeight:'bold' }}>Enterprise</p>

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Live Support</p>
                {pCell('addon_pm_essential_live_support', 100)}
                {pCell('addon_pm_professional_live_support', 50)}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Analytics</p>
                {pCell('addon_pm_essential_analytics', 20)}
                {pCell('addon_pm_professional_analytics', 10)}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Visitor QR</p>
                {pCell('addon_pm_essential_visitor_qr', 15)}
                {iCell}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Registration QR</p>
                {pCell('addon_pm_essential_registration_qr', 15)}
                {pCell('addon_pm_professional_registration_qr', 10)}
                {iCell}

                <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>Extra Property</p>
                {pCell('addon_pm_essential_extra_property', 8)}
                {pCell('addon_pm_professional_extra_property', 6)}
                {pCell('addon_pm_enterprise_extra_property', 4)}
              </div>

              {pricingMsg && (
                <div style={{ background: pricingMsg.includes('Error') ? '#3a1a1a' : '#1a3a1a', border:`1px solid ${pricingMsg.includes('Error') ? '#b71c1c' : '#2e7d32'}`, borderRadius:'8px', padding:'10px 14px', marginBottom:'10px' }}>
                  <p style={{ color: pricingMsg.includes('Error') ? '#f44336' : '#4caf50', fontSize:'12px', margin:'0' }}>{pricingMsg}</p>
                </div>
              )}
              <button onClick={savePricing} style={{ ...bGold, width:'100%' }}>Save All Pricing</button>
            </div>

            {platformSettings.updated_at && (
              <p style={{ color:'#555', fontSize:'10px', textAlign:'center', margin:'8px 0 0' }}>Last updated: {new Date(platformSettings.updated_at).toLocaleString()}</p>
            )}
          </div>
        )}

        {/* ── ANALYTICS ── */}
        {activeTab === 'analytics' && (
          <div>
            {!adminAnalyticsLoaded ? (
              <p style={{ color:'#555', textAlign:'center', padding:'40px' }}>Loading analytics...</p>
            ) : !adminAnalytics ? null : (
              <>
                {/* Metric cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                  {[
                    { label:'Active Companies', val:adminAnalytics.activeCompanies, sub:'on platform', subColor:'#555' },
                    { label:'This Month Violations', val:adminAnalytics.thisMonthViolations, sub:'platform-wide', subColor:'#555' },
                    { label:'Total Properties', val:adminAnalytics.totalProps, sub:'across all companies', subColor:'#555' },
                    { label:'Total Drivers', val:adminAnalytics.totalDrivers, sub:'active on platform', subColor:'#555' },
                  ].map((c, i) => (
                    <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                      <p style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>{c.label}</p>
                      <p style={{ color:'white', fontSize:'26px', fontWeight:'bold', margin:'0', fontFamily:'Arial' }}>{c.val}</p>
                      <p style={{ color:c.subColor, fontSize:'11px', margin:'4px 0 0' }}>{c.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Companies by tier donut */}
                {adminAnalytics.tierData.length > 0 && (
                  <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Companies by Service Tier</p>
                    <div style={{ display:'flex', alignItems:'center', gap:'16px' }}>
                      <ResponsiveContainer width={160} height={160}>
                        <PieChart>
                          <Pie data={adminAnalytics.tierData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={72} paddingAngle={2}>
                            {adminAnalytics.tierData.map((entry: any, i: number) => (
                              <Cell key={i} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} itemStyle={{ color:'#aaa' }} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ flex:1 }}>
                        {adminAnalytics.tierData.map((t: any, i: number) => (
                          <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:'1px solid #1e2535' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                              <div style={{ width:'10px', height:'10px', borderRadius:'50%', background:t.color, flexShrink:0 }} />
                              <span style={{ color:'#aaa', fontSize:'12px', textTransform:'capitalize' }}>{t.name}</span>
                            </div>
                            <span style={{ color:'white', fontSize:'13px', fontWeight:'bold' }}>{t.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Platform violations trend */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Platform Violations Trend (6 Months)</p>
                  <ResponsiveContainer width="100%" height={170}>
                    <LineChart data={adminAnalytics.monthData} margin={{ top:4, right:4, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="month" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} itemStyle={{ color:'#C9A227' }} />
                      <Line type="monotone" dataKey="count" stroke="#C9A227" strokeWidth={2} dot={{ fill:'#C9A227', strokeWidth:0, r:3 }} activeDot={{ r:5 }} name="Violations" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Top 5 properties leaderboard */}
                {adminAnalytics.topProperties.length > 0 && (
                  <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Top 5 Most Active Properties</p>
                    {adminAnalytics.topProperties.map((p: any) => {
                      const medalColor = p.rank === 1 ? '#C9A227' : p.rank === 2 ? '#9E9E9E' : p.rank === 3 ? '#795548' : '#2a2f3d'
                      const maxCount = adminAnalytics.topProperties[0]?.count || 1
                      return (
                        <div key={p.rank} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                          <div style={{ width:'24px', height:'24px', borderRadius:'50%', background:medalColor, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                            <span style={{ color: p.rank <= 3 ? '#0f1117' : '#888', fontSize:'11px', fontWeight:'bold' }}>{p.rank}</span>
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 3px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</p>
                            <div style={{ height:'4px', background:'#1e2535', borderRadius:'2px' }}>
                              <div style={{ height:'4px', background: p.rank === 1 ? '#C9A227' : '#546E7A', borderRadius:'2px', width:`${Math.round((p.count / maxCount) * 100)}%` }} />
                            </div>
                          </div>
                          <span style={{ color:'white', fontSize:'13px', fontWeight:'bold', flexShrink:0 }}>{p.count}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

      </div>
    </main>
  )
}

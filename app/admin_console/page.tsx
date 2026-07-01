'use client'
// B228 Phase 1 — Super-Admin Console (replaces analytics + role-portal nav).
//
// 3-tab nav: Console / Onboarding / System. Existing /admin coexists
// until the new console proves complete (Jose's spec). NavBar trims
// role-portal links for admin role; the admin still has /admin via
// direct URL for CRUD until later phases migrate it here.
//
// Phase 1 scope:
//   - Console tab: Row 0 health strip + Subscribers CRM + drawer
//   - Onboarding tab: link to proposal-codes/new (stub)
//   - System tab: placeholder ("TBD" tiles per §0.4 — Phase 4)
//
// Deferred to later phases:
//   - Phase 2: scan-plate metering + cost section + spike flags
//   - Phase 3: deactivate-subscriber DEFINER RPC + type-to-confirm UI
//   - Phase 4: error-rate tile (audit_logs) + honest "TBD" elsewhere

import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

type Tab = 'console' | 'onboarding' | 'system'

interface CompanyAggregate {
  company_id:        number
  company_name:      string
  company_tier:      string | null
  company_tier_type: string | null
  account_state:     string | null
  is_active:         boolean
  properties_count:  number
  vehicles_active:   number
  vehicles_pending:  number
  violations_30d:    number
  passes_30d:        number
  plate_reads_24h:   number
  plate_reads_30d:   number  // B228 Phase 2 — extended
  active_flags:      number  // B228 Phase 2 — extended (placeholder; spike flags live in their own state)
}

// B228 Phase 2 — spike flag row from get_console_spike_flags
interface SpikeFlag {
  company_id:      number
  company_name:    string
  flag_type:       'plate_reads' | 'visitor_passes' | 'self_registrations' | 'bulk_uploads'
  last_24h:        number
  baseline_7d_avg: number
  threshold_pct:   number
  dismissed:       boolean
  dismissed_until: string | null
}

// B228 Phase 2 — per-property permit count for PM-track drawer
interface PmPropertyPermit {
  property_name:    string
  approved_permits: number
}

// B228 Phase 4 — platform_settings row shape (subset the console cares
// about; there are more fields but we only read/write the ones the
// migrated sections touch, matching legacy /admin behavior).
interface PermitTier {
  up_to:      number | null
  rate_cents: number
}
interface PlatformSettingsRow {
  default_logo_url?:                   string | null
  default_theme?:                      string | null
  default_support_phone?:              string | null
  default_support_email?:              string | null
  default_support_website?:            string | null
  price_pm_only_base?:                 number | null
  price_pm_only_per_property?:         number | null
  price_enforcement_only_base?:        number | null
  price_enforcement_only_per_property?: number | null
  permit_tiers?:                       PermitTier[] | null
}

interface CompanyDetail {
  id:                   number
  name:                 string
  primary_contact_name: string | null
  billing_email:        string | null
  phone:                string | null
  address:              string | null
  tier:                 string | null
  tier_type:            string | null
  account_state:        string | null
  is_active:            boolean
  created_at:           string | null
  stripe_customer_id:   string | null
  tdlr_license_number:  string | null
}

const GOLD = '#C9A227'

export default function AdminConsolePage() {
  const [tab, setTab] = useState<Tab>('console')
  const [loading, setLoading] = useState(true)
  const [authErr, setAuthErr] = useState<string | null>(null)
  const [aggregates, setAggregates] = useState<CompanyAggregate[]>([])
  const [drawerCompany, setDrawerCompany] = useState<CompanyDetail | null>(null)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  // B228 Phase 2 — spike flags, PM per-property drill, cost rates
  const [spikeFlags, setSpikeFlags] = useState<SpikeFlag[]>([])
  const [pmPropertyPermits, setPmPropertyPermits] = useState<PmPropertyPermit[] | null>(null)
  const [costRates, setCostRates] = useState<{ plate_read_usd: number; vin_lookup_usd: number }>({ plate_read_usd: 0.012, vin_lookup_usd: 0.05 })
  const [acking, setAcking] = useState<string | null>(null)
  // B228 Phase 3 — deactivate-subscriber state
  const [deactivateOpen, setDeactivateOpen] = useState(false)
  const [confirmTyped, setConfirmTyped] = useState('')
  const [deactivateReason, setDeactivateReason] = useState('')
  const [deactivating, setDeactivating] = useState(false)
  const [reactivating, setReactivating] = useState(false)
  // B228 Phase 4 — platform_settings state (Default Branding + Default
  // Support Info + Base Subscription Pricing). SAME id=1 row as legacy
  // /admin Platform tab writes — no fork; both surfaces write to
  // platform_settings.upsert({id:1, ...}). Coexistence discipline per
  // Jose: functionality moved, write path shared.
  //
  // permit_tiers JSONB: rate_cents INSIDE the JSON; UI shows dollars
  // (÷100 load, ×100 save). Matches the legacy editor exactly so a
  // catalog script run against the same DB produces the same result
  // regardless of which surface saved it.
  const [platformSettings, setPlatformSettings] = useState<PlatformSettingsRow>({})
  const [savingBranding, setSavingBranding] = useState(false)
  const [savingSupport, setSavingSupport] = useState(false)
  const [savingPricing, setSavingPricing] = useState(false)
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null)
  const [pricingMsg, setPricingMsg] = useState<string | null>(null)
  // B228 Phase 4 — System tab error-rate tile (real audit_logs number)
  const [errorRate24h, setErrorRate24h] = useState<number | null>(null)

  // Role gate — admin only.
  useEffect(() => {
    let cancelled = false
    async function gate() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      const { data: role } = await supabase.from('user_roles').select('role').ilike('email', user.email!).single()
      if (cancelled) return
      if (!role || role.role !== 'admin') {
        setAuthErr('Super-admin access required.')
        setLoading(false)
        return
      }
      // B228 Phase 1 + 2 + 4 — load aggregates, spike flags, cost rates,
      // full platform_settings row (Phase 4 branding/support/pricing),
      // and the error-rate 24h count. All super-admin-gated; role check
      // above already passed.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const [aggRes, flagsRes, settingsRes, errorRateRes] = await Promise.all([
        supabase.rpc('get_console_aggregates'),
        supabase.rpc('get_console_spike_flags'),
        supabase.from('platform_settings').select('*').eq('id', 1).maybeSingle(),
        // B228 Phase 4 — error-rate tile: 24h count of audit_logs rows
        // whose action carries FAIL/ERROR/FAILED semantics OR whose
        // new_values carries an error_class. head:true returns metadata
        // only — never crosses the row data over the wire.
        supabase.from('audit_logs')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', twentyFourHoursAgo)
          .or('action.ilike.%FAIL%,new_values->>error_class.not.is.null'),
      ])
      if (cancelled) return
      if (aggRes.error) {
        setAuthErr('Could not load console data: ' + aggRes.error.message)
        setLoading(false)
        return
      }
      setAggregates((aggRes.data ?? []) as CompanyAggregate[])
      // Spike flags + settings + error-rate are non-fatal — console
      // renders without them (with sensible defaults).
      if (!flagsRes.error) setSpikeFlags((flagsRes.data ?? []) as SpikeFlag[])
      else console.warn('[admin_console] spike flags load failed:', flagsRes.error.message)
      if (!settingsRes.error && settingsRes.data) {
        const row = settingsRes.data as PlatformSettingsRow & { api_cost_rates?: { plate_read_usd: number; vin_lookup_usd: number } }
        setPlatformSettings(row)
        if (row.api_cost_rates) setCostRates(row.api_cost_rates)
      } else if (settingsRes.error) {
        console.warn('[admin_console] platform_settings load failed:', settingsRes.error.message)
      }
      if (!errorRateRes.error) setErrorRate24h(errorRateRes.count ?? 0)
      else console.warn('[admin_console] error-rate load failed:', errorRateRes.error.message)
      setLoading(false)
    }
    gate()
    return () => { cancelled = true }
  }, [])

  // B228 Phase 3 — super_admin_deactivate_company RPC call.
  // Server-side enforces super-admin role check; client UX gates with
  // type-to-confirm. After success: refresh aggregates so the CRM row
  // reflects the new is_active state; close drawer to nudge the
  // operator out of the just-deactivated context.
  async function deactivateCurrent() {
    if (!drawerCompany) return
    if (confirmTyped.trim() !== drawerCompany.name) return
    setDeactivating(true)
    const { data, error } = await supabase.rpc('super_admin_deactivate_company', {
      p_company_id: drawerCompany.id,
      p_reason:     deactivateReason.trim() || null,
    })
    setDeactivating(false)
    if (error) {
      alert('Deactivate failed: ' + error.message)
      return
    }
    const result = data as { ok?: boolean; users_affected?: number; reason?: string } | null
    if (!result?.ok) {
      alert('Deactivate did not complete: ' + (result?.reason ?? 'unknown'))
      return
    }
    // Refresh aggregates so the CRM row's state badge updates.
    const { data: refreshed } = await supabase.rpc('get_console_aggregates')
    if (refreshed) setAggregates(refreshed as CompanyAggregate[])
    setDeactivateOpen(false)
    setConfirmTyped('')
    setDeactivateReason('')
    setDrawerCompany(null)
    alert(`Deactivated. Users affected: ${result.users_affected ?? 0}.`)
  }

  // Reactivate — pure mirror, no type-to-confirm (reversal is benign;
  // the type-gate was for blast-radius on the destructive side).
  async function reactivateCurrent() {
    if (!drawerCompany) return
    if (!window.confirm(`Reactivate ${drawerCompany.name}? Restores access for all users at the company.`)) return
    setReactivating(true)
    const { data, error } = await supabase.rpc('super_admin_reactivate_company', {
      p_company_id: drawerCompany.id,
    })
    setReactivating(false)
    if (error) {
      alert('Reactivate failed: ' + error.message)
      return
    }
    const result = data as { ok?: boolean; users_affected?: number; reason?: string } | null
    if (!result?.ok) {
      alert('Reactivate did not complete: ' + (result?.reason ?? 'unknown'))
      return
    }
    const { data: refreshed } = await supabase.rpc('get_console_aggregates')
    if (refreshed) setAggregates(refreshed as CompanyAggregate[])
    setDrawerCompany({ ...drawerCompany, is_active: true })
    alert(`Reactivated. Users restored: ${result.users_affected ?? 0}.`)
  }

  // B228 Phase 4 — validate permit_tiers before save (matches legacy
  // /admin logic; catalog script would reject a malformed bands JSONB).
  function validatePermitTiers(tiers: PermitTier[]): string | null {
    if (!Array.isArray(tiers) || tiers.length === 0) return null
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i]
      if (typeof t.rate_cents !== 'number' || !Number.isFinite(t.rate_cents) || t.rate_cents < 0)
        return `Band ${i + 1}: rate must be a non-negative number`
      const isLast = i === tiers.length - 1
      if (isLast) {
        if (t.up_to !== null) return `Trailing band ${i + 1} must have up_to=null (∞)`
      } else {
        if (typeof t.up_to !== 'number' || !Number.isFinite(t.up_to) || t.up_to < 1)
          return `Band ${i + 1}: up_to must be a positive integer`
        const prev = i > 0 ? tiers[i - 1].up_to ?? 0 : 0
        if (t.up_to <= prev) return `Band ${i + 1}: up_to must be > previous band's up_to`
      }
    }
    return null
  }

  // B228 Phase 4 — Default Branding save (logo url + color theme).
  // SAME platform_settings.upsert as legacy /admin savePlatformSettings —
  // both surfaces write the same id=1 row, one source of truth.
  async function saveBrandingDefaults() {
    setSavingBranding(true)
    setSettingsMsg(null)
    const fields = {
      default_logo_url: platformSettings.default_logo_url ?? null,
      default_theme:    platformSettings.default_theme    ?? 'gold',
    }
    const { error } = await supabase.from('platform_settings').upsert({ id: 1, ...fields, updated_at: new Date().toISOString() })
    setSavingBranding(false)
    if (error) { setSettingsMsg('Branding save failed: ' + error.message); return }
    setSettingsMsg('Branding defaults saved.')
    setTimeout(() => setSettingsMsg(null), 3000)
  }

  // B228 Phase 4 — Default Support Info save. Same write path.
  async function saveSupportDefaults() {
    setSavingSupport(true)
    setSettingsMsg(null)
    const fields = {
      default_support_phone:   platformSettings.default_support_phone   ?? null,
      default_support_email:   platformSettings.default_support_email   ?? null,
      default_support_website: platformSettings.default_support_website ?? null,
    }
    const { error } = await supabase.from('platform_settings').upsert({ id: 1, ...fields, updated_at: new Date().toISOString() })
    setSavingSupport(false)
    if (error) { setSettingsMsg('Support save failed: ' + error.message); return }
    setSettingsMsg('Support defaults saved.')
    setTimeout(() => setSettingsMsg(null), 3000)
  }

  // B228 Phase 4 — Base Subscription Pricing save. Same write path as
  // legacy /admin savePricing; permit_tiers validated identically.
  // rate_cents stored INSIDE the JSONB (matches catalog script's
  // expectation; UI does ×100 on save + ÷100 on display).
  async function savePricingSettings() {
    const tiersErr = validatePermitTiers((platformSettings.permit_tiers ?? []) as PermitTier[])
    if (tiersErr) { setPricingMsg('Error: ' + tiersErr); return }
    setSavingPricing(true)
    setPricingMsg(null)
    const fields = {
      price_pm_only_base:                  platformSettings.price_pm_only_base,
      price_pm_only_per_property:          platformSettings.price_pm_only_per_property,
      price_enforcement_only_base:         platformSettings.price_enforcement_only_base,
      price_enforcement_only_per_property: platformSettings.price_enforcement_only_per_property,
      permit_tiers:                        platformSettings.permit_tiers,
    }
    const { error } = await supabase.from('platform_settings').upsert({ id: 1, ...fields, updated_at: new Date().toISOString() })
    setSavingPricing(false)
    if (error) { setPricingMsg('Pricing save failed: ' + error.message); return }
    setPricingMsg('Pricing saved.')
    setTimeout(() => setPricingMsg(null), 3000)
  }

  // B228 Phase 4 — Logo upload helper. Uploads to the shared `logos`
  // bucket (same as legacy /admin uploadLogo), returns the public URL
  // via callback so caller can setPlatformSettings.
  async function uploadLogo(file: File): Promise<string | null> {
    if (file.size > 2 * 1024 * 1024) {
      setSettingsMsg('Logo file exceeds 2 MB limit.')
      return null
    }
    const ext = file.name.split('.').pop() || 'png'
    const filePath = `platform/logo-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('logos').upload(filePath, file, { upsert: true })
    if (error) { setSettingsMsg('Logo upload failed: ' + error.message); return null }
    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(filePath)
    return urlData.publicUrl
  }

  // B228 Phase 2 — acknowledge (dismiss) a spike flag. 7-day default
  // dismiss window (handled server-side in the RPC). Local-patch the
  // flag out of state so it disappears immediately; full refresh on
  // next manual reload picks up any new flags.
  async function acknowledgeFlag(companyId: number, flagType: SpikeFlag['flag_type']) {
    const key = `${companyId}:${flagType}`
    setAcking(key)
    const { data, error } = await supabase.rpc('acknowledge_console_flag', {
      p_company_id:    companyId,
      p_flag_type:     flagType,
      p_dismiss_until: null,
      p_note:          null,
    })
    setAcking(null)
    if (error) {
      alert('Could not acknowledge flag: ' + error.message)
      return
    }
    const result = data as { ok?: boolean; error?: string } | null
    if (result?.error) {
      alert('Could not acknowledge flag: ' + result.error)
      return
    }
    setSpikeFlags(prev => prev.filter(f => !(f.company_id === companyId && f.flag_type === flagType)))
  }

  async function openDrawer(companyId: number) {
    setDrawerLoading(true)
    setDrawerCompany(null)
    setPmPropertyPermits(null)
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, primary_contact_name, billing_email, phone, address, tier, tier_type, account_state, is_active, created_at, stripe_customer_id, tdlr_license_number')
      .eq('id', companyId)
      .single()
    if (error) {
      alert('Could not load company detail: ' + error.message)
      setDrawerLoading(false)
      return
    }
    const detail = data as CompanyDetail
    setDrawerCompany(detail)
    setDrawerLoading(false)

    // B228 Phase 2 — for PM-track subscribers, fetch the per-property
    // approved-permit breakdown. RPC returns empty for non-PM, so the
    // tier_type guard is belt-and-suspenders (UI section hides on
    // empty array anyway).
    if (detail.tier_type === 'property_management') {
      const { data: permits, error: permitsErr } = await supabase.rpc('get_console_pm_property_permits', { p_company_id: companyId })
      if (!permitsErr) setPmPropertyPermits((permits ?? []) as PmPropertyPermit[])
      else console.warn('[admin_console] pm property permits load failed:', permitsErr.message)
    }
  }

  if (loading) {
    return <main style={{ minHeight: '100vh', background: '#0f1117', color: '#888', padding: 24 }}>Loading console…</main>
  }
  if (authErr) {
    return (
      <main style={{ minHeight: '100vh', background: '#0f1117', color: '#f44336', padding: 24, fontFamily: 'Arial' }}>
        <p style={{ fontSize: 13 }}>{authErr}</p>
      </main>
    )
  }

  // ── Row 0 health strip values
  const activeSubs        = aggregates.filter(a => a.is_active).length
  const pastDueSubs       = aggregates.filter(a => a.account_state === 'past_due').length
  const suspendedSubs     = aggregates.filter(a => a.account_state === 'suspended').length
  const totalPermits      = aggregates.reduce((s, a) => s + a.vehicles_active, 0)
  const totalPending      = aggregates.reduce((s, a) => s + a.vehicles_pending, 0)
  // B228 Phase 2 — real metering data
  const totalScans24h     = aggregates.reduce((s, a) => s + a.plate_reads_24h, 0)
  const totalScans30d    = aggregates.reduce((s, a) => s + a.plate_reads_30d, 0)
  const estCost30dUsd     = totalScans30d * (costRates.plate_read_usd ?? 0)
  const activeFlagsCount  = spikeFlags.length

  const filteredAggregates = searchQ.trim().length === 0
    ? aggregates
    : aggregates.filter(a => a.company_name.toLowerCase().includes(searchQ.toLowerCase().trim()))

  // B228 Phase 2 — top consumer for the cost section (by 30d count)
  const topConsumer = aggregates.slice().sort((a, b) => b.plate_reads_30d - a.plate_reads_30d).find(a => a.plate_reads_30d > 0)

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', color: 'white', fontFamily: 'Arial' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px 40px' }}>

        {/* Header */}
        <div style={{ marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 4px' }}>ShieldMyLot</p>
          <h1 style={{ color: 'white', fontSize: 22, fontWeight: 'bold', margin: 0 }}>Super-Admin Console</h1>
          <p style={{ color: '#666', fontSize: 11, margin: '6px 0 0' }}>Internal — decision surface for ownership/leadership.</p>
        </div>

        {/* 3-tab nav */}
        <div style={{ display: 'flex', gap: 3, background: '#1e2535', borderRadius: 8, padding: 3, marginBottom: 16 }}>
          {(['console', 'onboarding', 'system'] as Tab[]).map(t => {
            const active = tab === t
            const label = t === 'console' ? 'Console' : t === 'onboarding' ? 'Onboarding' : 'System'
            return (
              <button key={t} onClick={() => setTab(t)}
                style={{
                  flex: 1, padding: '8px 0',
                  background: active ? GOLD : 'transparent',
                  color:      active ? '#0f1117' : '#888',
                  fontWeight: active ? 'bold' : 'normal',
                  fontSize: 12, border: 'none', borderRadius: 6,
                  cursor: 'pointer', fontFamily: 'Arial',
                }}>
                {label}
              </button>
            )
          })}
        </div>

        {/* ── CONSOLE TAB ─────────────────────────────────────── */}
        {tab === 'console' && (
          <div>
            {/* Row 0 health strip — 6 tiles (cost + flags real per Phase 2) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 14 }}>
              <HealthTile label="Active Subscribers" value={activeSubs} sub={pastDueSubs > 0 ? `${pastDueSubs} past-due ★` : 'all current'} subColor={pastDueSubs > 0 ? GOLD : '#4caf50'} />
              <HealthTile label="Past-Due" value={pastDueSubs} sub={pastDueSubs > 0 ? 'review dunning' : 'none'} subColor={pastDueSubs > 0 ? '#fbbf24' : '#555'} />
              <HealthTile label="Suspended" value={suspendedSubs} sub={suspendedSubs > 0 ? 'review' : 'none'} subColor={suspendedSubs > 0 ? '#f44336' : '#555'} />
              <HealthTile label="Approved Permits" value={totalPermits} sub={`${totalPending} pending`} subColor="#555" />
              <HealthTile label="Plate Scans 24h" value={totalScans24h} sub={`${totalScans30d} over 30d`} subColor="#555" />
              <HealthTile label="Risk Flags Open"
                value={activeFlagsCount}
                sub={activeFlagsCount > 0 ? 'review ↓' : 'all clear'}
                subColor={activeFlagsCount > 0 ? '#fbbf24' : '#4caf50'} />
            </div>

            {/* B228 Phase 2 — Cost section */}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const }}>
                <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>API Cost — 30 days (estimate)</p>
                <p style={{ color: '#666', fontSize: 10, margin: 0 }}>Rates editable in Platform Settings; this view = count × rate.</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
                <HealthTile label="Plate reads 30d" value={totalScans30d} sub={`@ $${(costRates.plate_read_usd ?? 0).toFixed(4)}/call`} subColor="#555" />
                <HealthTile label="Est. cost 30d" value={`$${estCost30dUsd.toFixed(2)}`} sub="plate reads × rate" subColor="#555" />
                <HealthTile label="Top consumer"
                  value={topConsumer ? topConsumer.company_name : '—'}
                  sub={topConsumer ? `${topConsumer.plate_reads_30d} scans` : 'no scans yet'}
                  subColor="#555" />
                <div style={{ background: '#0f1117', border: '1px dashed #3a4055', borderRadius: 10, padding: 14 }}>
                  <p style={{ color: '#aaa', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>VIN Lookup</p>
                  <p style={{ color: '#666', fontSize: 16, fontWeight: 'bold', margin: 0 }}>Pending</p>
                  <p style={{ color: '#555', fontSize: 10, margin: '4px 0 0' }}>Meter hook wired, awaits attorney clear</p>
                </div>
              </div>
            </div>

            {/* B228 Phase 2 — Spike Flags */}
            {spikeFlags.length > 0 && (
              <div style={{ background: '#1a1400', border: '1px solid #a16207', borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <p style={{ color: '#fbbf24', fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>
                  Risk Flags ({spikeFlags.length})
                </p>
                <p style={{ color: '#666', fontSize: 10, margin: '0 0 10px' }}>
                  Last-24h volume vs 7-day baseline. Mark "expected" to dismiss for 7 days (e.g. onboarding spike).
                </p>
                {spikeFlags.map((f, i) => {
                  const ackKey = `${f.company_id}:${f.flag_type}`
                  const isAcking = acking === ackKey
                  const pct = f.baseline_7d_avg > 0
                    ? Math.round((f.last_24h / f.baseline_7d_avg - 1) * 100)
                    : null
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 1.4fr 0.8fr 0.9fr', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #2a2a08' }}>
                      <span style={{ color: 'white', fontSize: 12 }}>{f.company_name}</span>
                      <span style={{ color: '#aaa', fontSize: 11, textTransform: 'capitalize' }}>{f.flag_type.replace(/_/g, ' ')}</span>
                      <span style={{ color: '#fbbf24', fontSize: 12, fontFamily: 'Arial' }}>
                        {f.last_24h} <span style={{ color: '#666', fontSize: 10 }}>vs {f.baseline_7d_avg.toFixed(1)}/d</span>
                      </span>
                      <span style={{ color: pct !== null && pct > 0 ? '#fbbf24' : '#666', fontSize: 11, textAlign: 'right' }}>
                        {pct !== null ? `+${pct}%` : '—'}
                      </span>
                      <button onClick={() => acknowledgeFlag(f.company_id, f.flag_type)} disabled={isAcking}
                        style={{ padding: '4px 8px', background: '#1e2535', color: isAcking ? '#555' : '#aaa', border: '1px solid #3a4055', borderRadius: 6, cursor: isAcking ? 'not-allowed' : 'pointer', fontSize: 10, fontFamily: 'Arial' }}>
                        {isAcking ? '...' : 'Mark expected'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Subscribers CRM */}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const }}>
                <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
                  Subscribers ({aggregates.length})
                </p>
                <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                  placeholder="Search company name…"
                  style={{ background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '6px 10px', borderRadius: 6, fontSize: 12, minWidth: 200, fontFamily: 'Arial' }} />
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: '#666', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>
                      <Th>Company</Th>
                      <Th>Track</Th>
                      <Th>Tier</Th>
                      <Th align="center">State</Th>
                      <Th align="right">Properties</Th>
                      <Th align="right">Active Vehicles</Th>
                      <Th align="right">Pending</Th>
                      <Th align="right">Viols 30d</Th>
                      <Th align="right">Passes 30d</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAggregates.map(a => (
                      <tr key={a.company_id}
                        onClick={() => openDrawer(a.company_id)}
                        style={{ background: '#0f1117', borderTop: '1px solid #1e2535', cursor: 'pointer' }}>
                        <Td>
                          <span style={{ color: 'white', fontWeight: 'bold' }}>{a.company_name}</span>
                        </Td>
                        <Td><span style={{ color: '#aaa' }}>{a.company_tier_type ?? '—'}</span></Td>
                        <Td><span style={{ color: '#aaa' }}>{a.company_tier ?? '—'}</span></Td>
                        <Td align="center"><StateBadge state={a.account_state} isActive={a.is_active} /></Td>
                        <Td align="right"><span style={{ color: '#aaa' }}>{a.properties_count}</span></Td>
                        <Td align="right"><span style={{ color: 'white' }}>{a.vehicles_active}</span></Td>
                        <Td align="right">
                          <span style={{ color: a.vehicles_pending > 0 ? GOLD : '#555' }}>{a.vehicles_pending}</span>
                        </Td>
                        <Td align="right"><span style={{ color: '#aaa' }}>{a.violations_30d}</span></Td>
                        <Td align="right"><span style={{ color: '#aaa' }}>{a.passes_30d}</span></Td>
                      </tr>
                    ))}
                    {filteredAggregates.length === 0 && (
                      <tr><td colSpan={9} style={{ padding: 14, color: '#555', textAlign: 'center' }}>No subscribers match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p style={{ color: '#555', fontSize: 10, margin: '10px 0 0' }}>Click a row to view contact + billing details.</p>
            </div>
          </div>
        )}

        {/* ── ONBOARDING TAB ──────────────────────────────────── */}
        {tab === 'onboarding' && (
          <div>
            {/* Tool links */}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18, marginBottom: 14 }}>
              <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' }}>Onboarding Tools</p>
              <div style={{ display: 'grid', gap: 10 }}>
                <a href="/admin/proposal-codes/new"
                  style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 14, textDecoration: 'none', color: 'white' }}>
                  <p style={{ color: 'white', fontSize: 13, fontWeight: 'bold', margin: '0 0 4px' }}>Generate Proposal Code →</p>
                  <p style={{ color: '#888', fontSize: 11, margin: 0 }}>Onboard a new subscriber. Stages Stripe price catalog + sets initial entitlements.</p>
                </a>
                <a href="/admin"
                  style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 14, textDecoration: 'none', color: 'white' }}>
                  <p style={{ color: 'white', fontSize: 13, fontWeight: 'bold', margin: '0 0 4px' }}>Legacy /admin (CRUD + bulk + audit log) →</p>
                  <p style={{ color: '#888', fontSize: 11, margin: 0 }}>Company / Property / User / Driver / Facility CRUD + bulk upload + audit log. Operational surfaces stay here per Phase 4 scope.</p>
                </a>
              </div>
            </div>

            {/* B228 Phase 4 — Base Subscription Pricing editor migrated
                from legacy /admin Platform tab. SAME platform_settings
                write path as legacy savePricing; both surfaces update
                the same id=1 row. rate_cents stored INSIDE permit_tiers
                JSONB (matches catalog script); UI shows/edits dollars. */}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18 }}>
              <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Base Subscription Pricing</p>
              <p style={{ color: '#666', fontSize: 11, margin: '0 0 14px' }}>3-tier model: base fee + per-property; PM-Only adds graduated per-permit metering. Changes apply to new signups.</p>

              {/* PM-Only card */}
              <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <p style={{ color: '#4fc3f7', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>PM-Only · self-serve</p>
                <PriceRow label="Base / mo" value={platformSettings.price_pm_only_base}
                  onChange={v => setPlatformSettings(s => ({ ...s, price_pm_only_base: v }))} />
                <PriceRow label="Per Property / mo" value={platformSettings.price_pm_only_per_property}
                  onChange={v => setPlatformSettings(s => ({ ...s, price_pm_only_per_property: v }))} />

                <p style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 6px', fontWeight: 'bold' }}>Graduated Permit Tiers</p>
                <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr 60px', gap: 4, marginBottom: 4 }}>
                  <p style={{ color: '#666', fontSize: 9, margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Up to</p>
                  <p style={{ color: '#666', fontSize: 9, margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>$ / Permit</p>
                  <div />
                </div>
                {((platformSettings.permit_tiers ?? []) as PermitTier[]).map((band, idx, arr) => {
                  const isLast = idx === arr.length - 1
                  return (
                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 60px', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                      {isLast ? (
                        <span style={{ color: '#888', fontSize: 13, fontStyle: 'italic', paddingLeft: 4 }}>∞</span>
                      ) : (
                        <input type="number" min={1} step={1} value={band.up_to ?? ''}
                          onChange={e => {
                            const v = e.target.value === '' ? null : parseInt(e.target.value, 10)
                            setPlatformSettings(s => {
                              const next = [...((s.permit_tiers ?? []) as PermitTier[])]
                              next[idx] = { ...next[idx], up_to: v }
                              return { ...s, permit_tiers: next }
                            })
                          }}
                          style={priceInputStyle} />
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ color: '#555', fontSize: 10 }}>$</span>
                        <input type="number" min={0} step={0.01} value={(band.rate_cents / 100).toFixed(2)}
                          onChange={e => {
                            const dollars = parseFloat(e.target.value)
                            const cents = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0
                            setPlatformSettings(s => {
                              const next = [...((s.permit_tiers ?? []) as PermitTier[])]
                              next[idx] = { ...next[idx], rate_cents: cents }
                              return { ...s, permit_tiers: next }
                            })
                          }}
                          style={priceInputStyle} />
                      </div>
                      {!isLast && arr.length > 1 ? (
                        <button type="button"
                          onClick={() => setPlatformSettings(s => ({ ...s, permit_tiers: ((s.permit_tiers ?? []) as PermitTier[]).filter((_, i) => i !== idx) }))}
                          style={{ background: '#3a1a1a', color: '#f44336', border: '1px solid #b71c1c', borderRadius: 4, padding: '4px 6px', cursor: 'pointer', fontSize: 10 }}>
                          Remove
                        </button>
                      ) : <div />}
                    </div>
                  )
                })}
                <button type="button"
                  onClick={() => setPlatformSettings(s => {
                    const cur = (s.permit_tiers ?? []) as PermitTier[]
                    if (cur.length === 0) return { ...s, permit_tiers: [{ up_to: 50, rate_cents: 200 }, { up_to: null, rate_cents: 100 }] }
                    const last = cur[cur.length - 1]
                    if (last.up_to === null) {
                      const prevBounded = cur.slice(0, -1)
                      const lastBoundedUpTo = prevBounded.length > 0 ? (prevBounded[prevBounded.length - 1].up_to ?? 0) : 0
                      return { ...s, permit_tiers: [...prevBounded, { up_to: lastBoundedUpTo + 50, rate_cents: last.rate_cents }, last] }
                    }
                    return { ...s, permit_tiers: [...cur, { up_to: null, rate_cents: 100 }] }
                  })}
                  style={{ background: '#1e2535', color: '#4fc3f7', border: '1px solid #4fc3f7', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 11, marginTop: 8 }}>
                  + Add Band
                </button>
                <p style={{ color: '#555', fontSize: 9, margin: '8px 0 0', fontStyle: 'italic' }}>Bands fill bottom-up (first band counts permits 1–N; ∞ catches all above the last bounded up_to).</p>
              </div>

              {/* Enforcement-Only card */}
              <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <p style={{ color: '#b39ddb', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Enforcement-Only · self-serve</p>
                <PriceRow label="Base / mo" value={platformSettings.price_enforcement_only_base}
                  onChange={v => setPlatformSettings(s => ({ ...s, price_enforcement_only_base: v }))} />
                <PriceRow label="Per Property / mo" value={platformSettings.price_enforcement_only_per_property}
                  onChange={v => setPlatformSettings(s => ({ ...s, price_enforcement_only_per_property: v }))} />
                <p style={{ color: '#555', fontSize: 9, margin: '8px 0 0', fontStyle: 'italic' }}>No per-permit metering — Enforcement-Only does not issue PM permits.</p>
              </div>

              {/* Legacy card (negotiated; no inputs) */}
              <div style={{ background: '#0f1117', border: '1px dashed #3a4055', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <p style={{ color: '#888', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Legacy · negotiated</p>
                <p style={{ color: '#666', fontSize: 11, margin: 0 }}>Custom-negotiated pricing set per-proposal-code at issue time. No defaults here.</p>
              </div>

              <button onClick={savePricingSettings} disabled={savingPricing}
                style={{ width: '100%', padding: 10, background: savingPricing ? '#1e2535' : GOLD, color: savingPricing ? '#555' : '#0f1117', fontWeight: 'bold', fontSize: 12, border: 'none', borderRadius: 8, cursor: savingPricing ? 'not-allowed' : 'pointer', fontFamily: 'Arial', marginTop: 4 }}>
                {savingPricing ? 'Saving…' : 'Save Pricing'}
              </button>

              {pricingMsg && (
                <div style={{ padding: 10, marginTop: 10, background: pricingMsg.includes('failed') || pricingMsg.startsWith('Error') ? '#3a1a1a' : '#1a3a1a', border: `1px solid ${pricingMsg.includes('failed') || pricingMsg.startsWith('Error') ? '#b71c1c' : '#2e7d32'}`, borderRadius: 8, color: pricingMsg.includes('failed') || pricingMsg.startsWith('Error') ? '#f44336' : '#4caf50', fontSize: 12 }}>
                  {pricingMsg}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SYSTEM TAB ──────────────────────────────────────── */}
        {tab === 'system' && (
          <div>
            {/* System Health tiles */}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18, marginBottom: 14 }}>
              <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>System Health</p>
              <p style={{ color: '#666', fontSize: 11, margin: '0 0 12px' }}>Only what's cheaply queryable ships as real numbers. External integrations (RLS advisor, response time, last-deploy) render "—" with tooltip — no fake numbers.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                {/* B228 Phase 4 — REAL error-rate tile from audit_logs. */}
                <HealthTile
                  label="Error rate 24h"
                  value={errorRate24h === null ? '—' : errorRate24h}
                  sub={errorRate24h === null ? 'load failed' : (errorRate24h === 0 ? 'clean' : 'review audit_logs')}
                  subColor={errorRate24h === null ? '#555' : errorRate24h === 0 ? '#4caf50' : '#fbbf24'} />
                <HealthTile label="RLS advisor" value="—" sub="Supabase dashboard only (no API)" subColor="#555" />
                <HealthTile label="Avg response" value="—" sub="DB-perf investigation pending" subColor="#555" />
                <HealthTile label="Last deploy" value="—" sub="Vercel API integration TBD" subColor="#555" />
              </div>
            </div>

            {/* B228 Phase 4 — Settings section: Default Branding +
                Default Support Info migrated from legacy /admin Platform
                tab. SAME platform_settings.upsert; legacy Platform tab
                still works during coexistence. */}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18, marginBottom: 14 }}>
              <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>Settings — Default Branding</p>
              <p style={{ color: '#666', fontSize: 11, margin: '0 0 12px' }}>Applies to all new companies unless overridden per company.</p>

              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>Default logo URL</label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                <input value={platformSettings.default_logo_url ?? ''}
                  onChange={e => setPlatformSettings(s => ({ ...s, default_logo_url: e.target.value }))}
                  placeholder="https://…/logo.png"
                  style={{ flex: 1, background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'Arial' }} />
                <label style={{ padding: '8px 12px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: 'Arial' }}>
                  Upload
                  <input type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={async e => {
                      const f = e.target.files?.[0]; if (!f) return
                      const url = await uploadLogo(f)
                      if (url) setPlatformSettings(s => ({ ...s, default_logo_url: url }))
                      e.target.value = ''
                    }} />
                </label>
              </div>

              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>Default color theme</label>
              <select value={platformSettings.default_theme ?? 'gold'}
                onChange={e => setPlatformSettings(s => ({ ...s, default_theme: e.target.value }))}
                style={{ width: '100%', background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 14, fontFamily: 'Arial' }}>
                <option value="gold">Gold (Default)</option>
                <option value="blue">Ocean Blue</option>
                <option value="green">Forest Green</option>
                <option value="grey">Steel Grey</option>
                <option value="red">Crimson</option>
              </select>

              <button onClick={saveBrandingDefaults} disabled={savingBranding}
                style={{ width: '100%', padding: 10, background: savingBranding ? '#1e2535' : GOLD, color: savingBranding ? '#555' : '#0f1117', fontWeight: 'bold', fontSize: 12, border: 'none', borderRadius: 8, cursor: savingBranding ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
                {savingBranding ? 'Saving…' : 'Save Branding Defaults'}
              </button>
            </div>

            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18, marginBottom: 14 }}>
              <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>Settings — Default Support Info</p>
              <p style={{ color: '#666', fontSize: 11, margin: '0 0 12px' }}>Shown to residents and visitors when contacting support.</p>

              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>Default support phone</label>
              <input value={platformSettings.default_support_phone ?? ''}
                onChange={e => setPlatformSettings(s => ({ ...s, default_support_phone: e.target.value }))}
                placeholder="346-428-7864"
                style={{ width: '100%', background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 10, fontFamily: 'Arial', boxSizing: 'border-box' }} />

              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>Default support email</label>
              <input value={platformSettings.default_support_email ?? ''}
                onChange={e => setPlatformSettings(s => ({ ...s, default_support_email: e.target.value }))}
                placeholder="support@example.com"
                style={{ width: '100%', background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 10, fontFamily: 'Arial', boxSizing: 'border-box' }} />

              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>Default support website</label>
              <input value={platformSettings.default_support_website ?? ''}
                onChange={e => setPlatformSettings(s => ({ ...s, default_support_website: e.target.value }))}
                placeholder="example.com"
                style={{ width: '100%', background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 14, fontFamily: 'Arial', boxSizing: 'border-box' }} />

              <button onClick={saveSupportDefaults} disabled={savingSupport}
                style={{ width: '100%', padding: 10, background: savingSupport ? '#1e2535' : GOLD, color: savingSupport ? '#555' : '#0f1117', fontWeight: 'bold', fontSize: 12, border: 'none', borderRadius: 8, cursor: savingSupport ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
                {savingSupport ? 'Saving…' : 'Save Support Defaults'}
              </button>
            </div>

            {settingsMsg && (
              <div style={{ padding: 10, background: settingsMsg.includes('failed') ? '#3a1a1a' : '#1a3a1a', border: `1px solid ${settingsMsg.includes('failed') ? '#b71c1c' : '#2e7d32'}`, borderRadius: 8, color: settingsMsg.includes('failed') ? '#f44336' : '#4caf50', fontSize: 12 }}>
                {settingsMsg}
              </div>
            )}
          </div>
        )}

        {/* ── DRAWER ──────────────────────────────────────────── */}
        {drawerCompany && (
          <div onClick={() => setDrawerCompany(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', justifyContent: 'flex-end' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: '#161b26', borderLeft: '1px solid #2a2f3d', width: 380, maxWidth: '90vw', padding: 18, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Subscriber Detail</p>
                <button onClick={() => setDrawerCompany(null)}
                  style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
              </div>

              <p style={{ color: 'white', fontSize: 18, fontWeight: 'bold', margin: '0 0 12px' }}>{drawerCompany.name}</p>

              <DetailRow label="Contact"        value={drawerCompany.primary_contact_name} />
              <DetailRow label="Billing email"  value={drawerCompany.billing_email}        notSetCopy="— (not set — populate or sync from Stripe)" />
              <DetailRow label="Phone"          value={drawerCompany.phone} />
              <DetailRow label="Address"        value={drawerCompany.address} />
              <hr style={{ border: 'none', borderTop: '1px solid #2a2f3d', margin: '14px 0' }} />
              <DetailRow label="Track"          value={drawerCompany.tier_type} />
              <DetailRow label="Tier"           value={drawerCompany.tier} />
              <DetailRow label="Account state"  value={drawerCompany.account_state} />
              <DetailRow label="Is active"      value={drawerCompany.is_active ? 'yes' : 'no'} />
              <DetailRow label="Created"        value={drawerCompany.created_at?.slice(0, 10) ?? null} />
              <DetailRow label="Stripe customer" value={drawerCompany.stripe_customer_id} mono />
              <DetailRow label="TDLR license"   value={drawerCompany.tdlr_license_number} />

              {/* B228 Phase 2 — per-property approved-permit breakdown.
                  PM-track subscribers only. Section omitted for enforcement
                  (RPC returns empty). Sales/health signal: which property
                  is heavy, who's drifting toward a tier ceiling. */}
              {drawerCompany.tier_type === 'property_management' && pmPropertyPermits !== null && pmPropertyPermits.length > 0 && (
                <>
                  <hr style={{ border: 'none', borderTop: '1px solid #2a2f3d', margin: '14px 0' }} />
                  <p style={{ color: GOLD, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
                    Approved Permits by Property
                  </p>
                  {pmPropertyPermits.map((p, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1e2535' }}>
                      <span style={{ color: '#aaa', fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.property_name}</span>
                      <span style={{ color: 'white', fontSize: 13, fontWeight: 'bold' }}>{p.approved_permits}</span>
                    </div>
                  ))}
                  <p style={{ color: '#555', fontSize: 10, margin: '8px 0 0' }}>Actuals from live data. Future-subscriber sizing lives in the proposal calculator.</p>
                </>
              )}

              <hr style={{ border: 'none', borderTop: '1px solid #2a2f3d', margin: '14px 0' }} />
              {/* B228 Phase 3 — Deactivate / Reactivate (access-only).
                  account_state is intentionally untouched (dunning + Stripe
                  own it). Type-to-confirm gates the destructive direction;
                  reactivate just does a window.confirm. */}
              {drawerCompany.is_active ? (
                <button onClick={() => setDeactivateOpen(true)}
                  style={{ width: '100%', padding: 10, background: '#3a1a1a', color: '#f44336', border: '1px solid #b71c1c', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', fontFamily: 'Arial' }}>
                  Deactivate subscriber
                </button>
              ) : (
                <button onClick={reactivateCurrent} disabled={reactivating}
                  style={{ width: '100%', padding: 10, background: reactivating ? '#1e2535' : '#1a3a1a', color: reactivating ? '#555' : '#4caf50', border: `1px solid ${reactivating ? '#3a4055' : '#2e7d32'}`, borderRadius: 8, cursor: reactivating ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 'bold', fontFamily: 'Arial' }}>
                  {reactivating ? 'Reactivating…' : 'Reactivate subscriber'}
                </button>
              )}
              <p style={{ color: '#555', fontSize: 10, margin: '8px 0 0' }}>
                Access-only lever. Does not change account_state (Stripe + dunning own that). Routine billing flows are untouched.
              </p>
            </div>
          </div>
        )}

        {/* B228 Phase 3 — type-to-confirm dialog */}
        {deactivateOpen && drawerCompany && (
          <div onClick={() => { if (!deactivating) { setDeactivateOpen(false); setConfirmTyped(''); setDeactivateReason('') } }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: '#161b26', border: '1px solid #b71c1c', borderRadius: 10, width: 440, maxWidth: '92vw', padding: 20 }}>
              <p style={{ color: '#f44336', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px', fontWeight: 'bold' }}>Confirm Deactivate</p>
              <p style={{ color: 'white', fontSize: 14, fontWeight: 'bold', margin: '0 0 6px' }}>{drawerCompany.name}</p>
              <p style={{ color: '#aaa', fontSize: 12, margin: '0 0 14px', lineHeight: 1.5 }}>
                This revokes access for every user at this company. Active sessions are booted on next focus. Reversible via Reactivate. <strong style={{ color: 'white' }}>account_state is NOT changed</strong> — dunning + Stripe own billing state.
              </p>
              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>Reason (optional, audited)</label>
              <input value={deactivateReason} onChange={e => setDeactivateReason(e.target.value)}
                placeholder="e.g. contract breach — abusive scan volume"
                style={{ width: '100%', background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 12, fontFamily: 'Arial', boxSizing: 'border-box' }} />
              <label style={{ color: '#aaa', fontSize: 11, display: 'block', margin: '0 0 4px' }}>
                Type <strong style={{ color: '#f44336', fontFamily: 'monospace' }}>{drawerCompany.name}</strong> to enable Confirm
              </label>
              <input value={confirmTyped} onChange={e => setConfirmTyped(e.target.value)}
                placeholder={drawerCompany.name}
                style={{ width: '100%', background: '#0f1117', border: '1px solid #2a2f3d', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 16, fontFamily: 'monospace', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={deactivateCurrent}
                  disabled={deactivating || confirmTyped.trim() !== drawerCompany.name}
                  style={{ flex: 1, padding: 10, background: (deactivating || confirmTyped.trim() !== drawerCompany.name) ? '#1e2535' : '#3a1a1a', color: (deactivating || confirmTyped.trim() !== drawerCompany.name) ? '#555' : '#f44336', border: `1px solid ${(deactivating || confirmTyped.trim() !== drawerCompany.name) ? '#3a4055' : '#b71c1c'}`, borderRadius: 8, cursor: (deactivating || confirmTyped.trim() !== drawerCompany.name) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 'bold', fontFamily: 'Arial' }}>
                  {deactivating ? 'Deactivating…' : 'Confirm Deactivate'}
                </button>
                <button onClick={() => { setDeactivateOpen(false); setConfirmTyped(''); setDeactivateReason('') }} disabled={deactivating}
                  style={{ padding: '10px 16px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: 8, cursor: deactivating ? 'not-allowed' : 'pointer', fontSize: 12, fontFamily: 'Arial' }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {drawerLoading && (
          <div style={{ position: 'fixed', bottom: 16, right: 16, background: '#1e2535', padding: '8px 12px', borderRadius: 6, color: '#aaa', fontSize: 11 }}>
            Loading detail…
          </div>
        )}
      </div>
    </main>
  )
}

// ── Inline subcomponents ───────────────────────────────────────────

// B228 Phase 4 — shared price-input row for the pricing editor.
const priceInputStyle: React.CSSProperties = {
  flex: 1, background: '#0a0d14', border: '1px solid #2a2f3d', color: 'white',
  padding: '5px 8px', borderRadius: 4, fontSize: 12, fontFamily: 'Arial', width: '100%', boxSizing: 'border-box',
}

function PriceRow({ label, value, onChange }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      <span style={{ color: '#aaa', fontSize: 11 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: '#555', fontSize: 10 }}>$</span>
        <input type="number" step={0.01} min={0} value={value ?? ''}
          onChange={e => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
          style={priceInputStyle} />
      </div>
    </div>
  )
}

function HealthTile({ label, value, sub, subColor }: { label: string; value: number | string; sub: string; subColor: string }) {
  return (
    <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 14 }}>
      <p style={{ color: '#aaa', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>{label}</p>
      <p style={{ color: 'white', fontSize: 22, fontWeight: 'bold', margin: 0 }}>{value}</p>
      <p style={{ color: subColor, fontSize: 10, margin: '4px 0 0' }}>{sub}</p>
    </div>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <th style={{ textAlign: align as React.CSSProperties['textAlign'], padding: '6px 10px', fontWeight: 'normal' }}>{children}</th>
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <td style={{ textAlign: align as React.CSSProperties['textAlign'], padding: '8px 10px' }}>{children}</td>
}

function StateBadge({ state, isActive }: { state: string | null; isActive: boolean }) {
  let bg = '#1e2535', color = '#aaa', label = state ?? (isActive ? 'active' : 'inactive')
  if (!isActive)                  { bg = '#3a1a1a'; color = '#f44336'; label = 'inactive' }
  else if (state === 'active')    { bg = '#1a3a1a'; color = '#4caf50' }
  else if (state === 'past_due')  { bg = '#3a2a08'; color = '#fbbf24' }
  else if (state === 'suspended') { bg = '#3a1a1a'; color = '#f44336' }
  else if (state === 'cancelled') { bg = '#3a1a1a'; color = '#f44336' }
  return <span style={{ background: bg, color, padding: '2px 6px', borderRadius: 8, fontSize: 9, fontWeight: 'bold' }}>{label}</span>
}

function DetailRow({ label, value, mono, notSetCopy }: { label: string; value: string | null | undefined; mono?: boolean; notSetCopy?: string }) {
  const set = value !== null && value !== undefined && value.length > 0
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid #1e2535' }}>
      <span style={{ color: '#666', fontSize: 11 }}>{label}</span>
      <span style={{ color: set ? 'white' : '#555', fontSize: 12, textAlign: 'right', maxWidth: 220, wordBreak: 'break-word', fontFamily: mono ? 'monospace' : 'Arial' }}>
        {set ? value : (notSetCopy ?? '—')}
      </span>
    </div>
  )
}

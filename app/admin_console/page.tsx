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
      // B228 Phase 1 + 2 — load aggregates, spike flags, and cost
      // rates in parallel. All three are super-admin-gated; the role
      // check above already passed.
      const [aggRes, flagsRes, ratesRes] = await Promise.all([
        supabase.rpc('get_console_aggregates'),
        supabase.rpc('get_console_spike_flags'),
        supabase.from('platform_settings').select('api_cost_rates').eq('id', 1).maybeSingle(),
      ])
      if (cancelled) return
      if (aggRes.error) {
        setAuthErr('Could not load console data: ' + aggRes.error.message)
        setLoading(false)
        return
      }
      setAggregates((aggRes.data ?? []) as CompanyAggregate[])
      // Spike flags + rates are non-fatal — console renders without them.
      if (!flagsRes.error) setSpikeFlags((flagsRes.data ?? []) as SpikeFlag[])
      else console.warn('[admin_console] spike flags load failed:', flagsRes.error.message)
      if (!ratesRes.error && ratesRes.data?.api_cost_rates) {
        setCostRates(ratesRes.data.api_cost_rates as { plate_read_usd: number; vin_lookup_usd: number })
      }
      setLoading(false)
    }
    gate()
    return () => { cancelled = true }
  }, [])

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
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18 }}>
            <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' }}>Onboarding Tools</p>
            <div style={{ display: 'grid', gap: 10 }}>
              <a href="/admin/proposal-codes/new"
                style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 14, textDecoration: 'none', color: 'white' }}>
                <p style={{ color: 'white', fontSize: 13, fontWeight: 'bold', margin: '0 0 4px' }}>Generate Proposal Code →</p>
                <p style={{ color: '#888', fontSize: 11, margin: 0 }}>Onboard a new subscriber. Stages Stripe price catalog + sets initial entitlements.</p>
              </a>
              <a href="/admin"
                style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 14, textDecoration: 'none', color: 'white' }}>
                <p style={{ color: 'white', fontSize: 13, fontWeight: 'bold', margin: '0 0 4px' }}>Existing Admin Surfaces →</p>
                <p style={{ color: '#888', fontSize: 11, margin: 0 }}>Company / Property / User / Driver / Facility CRUD + bulk upload + pricing editor. Migrates into this console in later phases.</p>
              </a>
            </div>
          </div>
        )}

        {/* ── SYSTEM TAB ──────────────────────────────────────── */}
        {tab === 'system' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 18 }}>
            <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' }}>System Health</p>
            <p style={{ color: '#888', fontSize: 12, margin: '0 0 12px' }}>Phase 4 — only what's cheaply queryable will ship here. RLS advisor, response time, and last-deploy require external integration (Vercel/Supabase APIs) — those tiles will render "—" with a tooltip rather than fake numbers.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
              <HealthTile label="Error rate 24h" value="—" sub="Phase 4" subColor="#555" />
              <HealthTile label="RLS advisor" value="—" sub="Supabase dashboard only" subColor="#555" />
              <HealthTile label="Avg response" value="—" sub="DB-perf investigation pending" subColor="#555" />
              <HealthTile label="Last deploy" value="—" sub="Vercel API integration" subColor="#555" />
            </div>
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
              <p style={{ color: '#666', fontSize: 11, margin: 0 }}>
                Deactivate subscriber → Phase 3 (super-admin DEFINER RPC with type-to-confirm).
              </p>
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

// ════════════════════════════════════════════════════════════════════
// /manager/mobile — walking-manager surface for a 250-unit community.
//
// Purpose (docs/backlog/manager-mobile-approval-lookup.md, Build 2):
//   1. See what's waiting (residents + vehicles pending approval)
//   2. Approve or decline, per row or bulk
//   3. Look up a resident by unit or plate, standing in front of a car
//
// Excluded on purpose: editing, spaces, violations, visitor passes,
// CSV export, deactivate. Destructive cascades stay on desktop.
//
// Reuses (verbatim, no reimplemented writes):
//   • app/lib/manager-crm-writes.ts — approve/decline cores, batch
//     primitive, runBulkApprove
//   • app/lib/bulk-approve-summary.ts — buildBulkApproveSummary.lines
//     rendered INLINE (no alert) for the bulk summary
//   • app/lib/plate.ts — normalizePlate() shared with enforcement
//   • app/lib/tier.ts — getCompanyContext() for PM-only cascade rule
//
// Discipline enforced here:
//   1. Role gate is manager + admin ONLY (see
//      feedback_leasing_agent_write_expansion_trap.md — leasing_agent
//      is isReadOnly on desktop; including them here is privilege
//      expansion via a convenience feature).
//   2. Property lookup via get_my_properties() RPC (equality on
//      lowercased email BOTH sides). Never .ilike('email', …) on
//      user_roles for property.
//   3. Narrow reads — pending-only on load; on-demand search;
//      refetchPending() after a write. NEVER refreshCrmData() —
//      that five-fanout was the whole reason this view exists.
//   4. PM-only cascade rule (feedback_mobile_pending_list_is_the_
//      confirmation.md) — per-row approveResident on pm_only does
//      NOT cascade; those vehicles stay pending and appear in the
//      queue, where approving them is the explicit consent. The
//      pending list IS the confirmation on mobile.
//   5. Bulk confirm kept verbatim from desktop — bulk is an explicit
//      action + scope info matters for billing.
// ════════════════════════════════════════════════════════════════════
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../supabase'
import { getCompanyContext } from '../../lib/tier'
import { normalizePlate } from '../../lib/plate'
import { escapeIlikeValue } from '../../lib/supabase-query-escape'
import { buildBulkApproveSummary } from '../../lib/bulk-approve-summary'
import {
  listPendingVehiclesForUnit,
  approveVehiclesBatch,
  approveResidentWrite,
  approveVehicleWrite,
  declineResidentWrite,
  declineVehicleWrite,
  runBulkApprove,
} from '../../lib/manager-crm-writes'

type PendingResident = { id: string; name: string | null; unit: string | null; email: string | null }
type PendingVehicle = {
  id: string
  plate: string | null
  unit: string | null
  make: string | null
  model: string | null
  color: string | null
  resident_email: string | null
}
type LookupResident = { id: string; name: string | null; unit: string | null; email: string | null; is_active: boolean }
type LookupVehicle = {
  id: string
  plate: string | null
  unit: string | null
  make: string | null
  model: string | null
  color: string | null
  status: string | null
  is_active: boolean
  resident_email: string | null
}

const C = {
  bg: '#0f1117',
  panel: '#1e2535',
  border: '#3a4055',
  gold: '#C9A227',
  goldSoft: 'rgba(201,162,39,0.08)',
  green: '#4caf50',
  greenDark: '#1a3a1a',
  greenBorder: '#2e7d32',
  red: '#f44336',
  redDark: '#3a1a1a',
  redBorder: '#b71c1c',
  text: '#e8e8e8',
  muted: '#888',
  faint: '#666',
}

export default function ManagerMobilePage() {
  const [gateStatus, setGateStatus] = useState<'checking' | 'ready' | 'unauthorized' | 'no_property' | 'error'>('checking')
  const [gateMessage, setGateMessage] = useState<string>('')
  const [propertyOptions, setPropertyOptions] = useState<{ name: string; company: string | null }[]>([])
  const [property, setProperty] = useState<string>('')
  const [companyIdForSync, setCompanyIdForSync] = useState<number | null>(null)
  const [canApprove, setCanApprove] = useState<boolean>(false)
  const [tier, setTier] = useState<string>('')
  const [screen, setScreen] = useState<'queue' | 'lookup'>('queue')

  // Queue state
  const [pendingResidents, setPendingResidents] = useState<PendingResident[]>([])
  const [pendingVehicles, setPendingVehicles] = useState<PendingVehicle[]>([])
  const [queueLoading, setQueueLoading] = useState<boolean>(false)
  const [busyResidentId, setBusyResidentId] = useState<string | null>(null)
  const [busyVehicleId, setBusyVehicleId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState<boolean>(false)
  const [bulkSummary, setBulkSummary] = useState<string[] | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  // Lookup state
  const [lookupInput, setLookupInput] = useState<string>('')
  const [lookupBusy, setLookupBusy] = useState<boolean>(false)
  const [lookupResults, setLookupResults] = useState<{ residents: LookupResident[]; vehicles: LookupVehicle[] } | null>(null)
  const [lookupMessage, setLookupMessage] = useState<string>('')

  // ── Gate + property bootstrap ─────────────────────────────────────
  useEffect(() => {
    async function bootstrap() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) { setGateStatus('unauthorized'); return }

      // Role gate via get_my_role() (equality-safe, duplicate-safe, DEFINER).
      const { data: role, error: roleErr } = await supabase.rpc('get_my_role')
      if (roleErr) {
        console.error('[Manager mobile] get_my_role failed', roleErr)
        setGateStatus('error'); setGateMessage('Could not verify your role. Try again in a moment.')
        return
      }
      if (role !== 'manager' && role !== 'admin') {
        setGateStatus('unauthorized')
        return
      }

      // Property lookup via get_my_properties() (lowercased both sides, DEFINER).
      const { data: props, error: propsErr } = await supabase.rpc('get_my_properties')
      if (propsErr) {
        console.error('[Manager mobile] get_my_properties failed', propsErr)
        setGateStatus('error'); setGateMessage('Could not load your properties. Try again in a moment.')
        return
      }
      const propList: string[] = Array.isArray(props) ? props.filter(Boolean) : []
      if (propList.length === 0) {
        setGateStatus('no_property')
        return
      }
      // Fetch {name, company} for each so we can resolve companyIdForSync
      // on property change (matches desktop's manager.company path).
      const { data: propRows, error: propRowsErr } = await supabase
        .from('properties')
        .select('name, company')
        .in('name', propList)
        .order('name')
      if (propRowsErr) console.error('[Manager mobile] properties row fetch failed', propRowsErr)
      const options = (propRows ?? []).map(p => ({ name: p.name, company: p.company ?? null }))
      if (options.length === 0) {
        setGateStatus('no_property')
        return
      }
      setPropertyOptions(options)
      setProperty(options[0].name)

      // can_approve_vehicles — no DEFINER helper yet (filed as follow-up).
      // Mitigated form: escapeIlikeValue neutralizes %/_ so this is
      // case-insensitive equality in practice. .limit(1).maybeSingle()
      // avoids the .single() dup-throw.
      const { data: roleRow, error: roleRowErr } = await supabase
        .from('user_roles')
        .select('can_approve_vehicles')
        .ilike('email', escapeIlikeValue(user.email))
        .limit(1)
        .maybeSingle()
      if (roleRowErr) {
        console.error('[Manager mobile] user_roles can_approve_vehicles read failed', roleRowErr)
      }
      // Admin: always allowed. Manager: per the column. leasing_agent
      // excluded above so this reduces to "manager sees the flag."
      setCanApprove(role === 'admin' || (roleRow?.can_approve_vehicles === true))
      setTier(getCompanyContext().tier || '')

      setGateStatus('ready')
    }
    bootstrap()
  }, [])

  // ── Refetch pending only ──────────────────────────────────────────
  async function refetchPending(prop: string = property) {
    if (!prop) return
    setQueueLoading(true)
    const { data: rData, error: rErr } = await supabase
      .from('residents')
      .select('id, name, unit, email')
      .ilike('property', escapeIlikeValue(prop))
      .eq('status', 'pending')
      .order('unit')
    if (rErr) console.error('[Manager mobile] pending residents fetch failed', rErr)
    const { data: vData, error: vErr } = await supabase
      .from('vehicles')
      .select('id, plate, unit, make, model, color, resident_email')
      .ilike('property', escapeIlikeValue(prop))
      .eq('status', 'pending')
      .order('unit')
    if (vErr) console.error('[Manager mobile] pending vehicles fetch failed', vErr)
    setPendingResidents((rData ?? []) as PendingResident[])
    setPendingVehicles((vData ?? []) as PendingVehicle[])
    setQueueLoading(false)
  }

  useEffect(() => {
    if (gateStatus === 'ready' && property) {
      refetchPending(property)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateStatus, property])

  // Resolve companyIdForSync from the selected property's company (matches
  // desktop useEffect at app/manager/page.tsx:332). Null on miss — sync
  // calls silently skip (safe; reconcileAtRenewal cron is the backstop).
  useEffect(() => {
    if (!property) { setCompanyIdForSync(null); return }
    const opt = propertyOptions.find(p => p.name === property)
    if (!opt?.company) { setCompanyIdForSync(null); return }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('companies').select('id')
        .ilike('name', escapeIlikeValue(opt.company!)).maybeSingle()
      if (!cancelled) setCompanyIdForSync(data?.id ? Number(data.id) : null)
    })()
    return () => { cancelled = true }
  }, [property, propertyOptions])

  // ── Handlers — reuse lib verbatim, refetch pending only ───────────
  async function handleApproveResident(r: PendingResident) {
    if (!canApprove) return
    setBusyResidentId(r.id); setWriteError(null); setBulkSummary(null)
    try {
      await approveResidentWrite(supabase, {
        resident: { id: r.id, name: r.name, unit: r.unit, email: r.email },
        property,
      })
      // PM-only cascade rule (memory: feedback_mobile_pending_list_is_
      // the_confirmation.md). Non-metered tiers cascade normally; pm_only
      // leaves the vehicles pending — they appear in this queue and the
      // manager approves each one explicitly.
      if (tier !== 'pm_only' && r.unit) {
        const unitPending = await listPendingVehiclesForUnit(supabase, { unit: r.unit, property })
        if (unitPending.length > 0) {
          await approveVehiclesBatch(supabase, {
            vehicles: unitPending.map(v => ({ id: v.id, plate: v.plate })),
            property,
            companyIdForSync,
            logSite: 'manager-mobile-approveResident-cascade',
          })
        }
      }
      await refetchPending()
    } catch (e) {
      console.error('[Manager mobile] approveResident failed', e)
      setWriteError(friendlyWriteError(e, 'single'))
    } finally {
      setBusyResidentId(null)
    }
  }

  async function handleDeclineResident(r: PendingResident) {
    setBusyResidentId(r.id); setWriteError(null); setBulkSummary(null)
    try {
      await declineResidentWrite(supabase, {
        resident: { id: r.id, name: r.name, unit: r.unit, email: r.email },
        property,
      })
      await refetchPending()
    } catch (e) {
      console.error('[Manager mobile] declineResident failed', e)
      setWriteError(friendlyWriteError(e, 'single'))
    } finally {
      setBusyResidentId(null)
    }
  }

  async function handleApproveVehicle(v: PendingVehicle) {
    if (!canApprove) return
    // PM-only per-vehicle prompt — desktop shows this too. Mobile keeps
    // it because per-vehicle approve is an explicit tap already; the
    // billing confirmation is per-decision, not per-surface.
    if (tier === 'pm_only') {
      if (!window.confirm('Approve this vehicle as a billable permit?')) return
    }
    setBusyVehicleId(v.id); setWriteError(null); setBulkSummary(null)
    try {
      await approveVehicleWrite(supabase, {
        vehicleId: v.id,
        property,
        companyIdForSync,
      })
      await refetchPending()
    } catch (e) {
      console.error('[Manager mobile] approveVehicle failed', e)
      setWriteError(friendlyWriteError(e, 'single'))
    } finally {
      setBusyVehicleId(null)
    }
  }

  async function handleDeclineVehicle(v: PendingVehicle) {
    setBusyVehicleId(v.id); setWriteError(null); setBulkSummary(null)
    try {
      await declineVehicleWrite(supabase, { vehicleId: v.id, property })
      await refetchPending()
    } catch (e) {
      console.error('[Manager mobile] declineVehicle failed', e)
      setWriteError(friendlyWriteError(e, 'single'))
    } finally {
      setBusyVehicleId(null)
    }
  }

  async function handleBulkApprove() {
    if (!canApprove || bulkBusy) return
    const rCount = pendingResidents.length
    const vCount = pendingVehicles.length
    if (rCount === 0 && vCount === 0) return
    // Bulk confirm kept verbatim from desktop — bulk is an explicit
    // action + scope info matters for billing (per Mateo Phase B2 Q2).
    const parts: string[] = []
    if (rCount > 0) parts.push(`${rCount} resident${rCount === 1 ? '' : 's'}`)
    if (vCount > 0) parts.push(`${vCount} vehicle${vCount === 1 ? '' : 's'}`)
    const scope = parts.join(' · ')
    const suffix = tier === 'pm_only' && vCount > 0 ? ' as billable permits' : ''
    if (!window.confirm(`Approve ${scope}${suffix}?\n\nResidents are approved first. Vehicles are approved only for residents whose approval succeeds.`)) return

    setBulkBusy(true); setWriteError(null); setBulkSummary(null)
    try {
      const result = await runBulkApprove(supabase, {
        property,
        companyIdForSync,
        pendingResidentsForBulk: pendingResidents,
        allPendingVehicles: pendingVehicles.map(v => ({
          id: v.id, plate: v.plate, resident_email: v.resident_email,
        })),
      })
      if (!result.ok) {
        // runBulkApprove returns {ok:false} ONLY when the pre-phase-1
        // active-residents fetch fails — verifiable "no writes attempted"
        // path, so the "nothing was changed" copy is accurate here.
        // (Mid-batch throws land in the catch(e) branch below with the
        // different copy that mentions the refetch.)
        console.error('[Manager mobile] bulk approve pre-flight failed', result.error)
        setWriteError(friendlyWriteError(result.error, 'bulk-preflight-failed'))
        return
      }
      // Render summary INLINE (not alert) via .lines — feedback-before-
      // refresh: setBulkSummary first, THEN refetch.
      setBulkSummary(buildBulkApproveSummary(result.summary).lines)
      await refetchPending()
    } catch (e) {
      // Mid-batch throw — writes may have partially completed. Refetch
      // BEFORE showing the message so the visible queue matches the
      // "the queue has been refreshed to show what actually landed" copy.
      console.error('[Manager mobile] bulk approve mid-batch failure', e)
      await refetchPending()
      setWriteError(friendlyWriteError(e, 'bulk-mid-batch'))
    } finally {
      setBulkBusy(false)
    }
  }

  // ── Lookup ────────────────────────────────────────────────────────
  async function handleLookup() {
    const raw = lookupInput.trim()
    if (!raw || lookupBusy) return
    setLookupBusy(true); setLookupResults(null); setLookupMessage('')
    try {
      const normPlate = normalizePlate(raw)
      // Search vehicles: plate OR unit. Uppercase already applied by
      // normalizePlate; unit search uses trimmed raw (case-insensitive).
      const { data: vByPlate } = await supabase
        .from('vehicles')
        .select('id, plate, unit, make, model, color, status, is_active, resident_email')
        .ilike('property', escapeIlikeValue(property))
        .eq('plate', normPlate)
      const { data: vByUnit } = await supabase
        .from('vehicles')
        .select('id, plate, unit, make, model, color, status, is_active, resident_email')
        .ilike('property', escapeIlikeValue(property))
        .ilike('unit', escapeIlikeValue(raw))
      // Merge by id.
      const vehiclesMap = new Map<string, LookupVehicle>()
      for (const v of (vByPlate ?? [])) vehiclesMap.set(v.id, v as LookupVehicle)
      for (const v of (vByUnit ?? [])) vehiclesMap.set(v.id, v as LookupVehicle)
      const vehicles = Array.from(vehiclesMap.values())

      // Search residents: unit only (plate isn't on residents). Plus
      // residents whose vehicles matched (owner-of-plate lookup).
      const unitSet = new Set<string>()
      for (const v of vehicles) if (v.unit) unitSet.add(v.unit)
      if (raw) unitSet.add(raw)
      const units = Array.from(unitSet)
      const residentPromises = units.map(u =>
        supabase.from('residents')
          .select('id, name, unit, email, is_active')
          .ilike('property', escapeIlikeValue(property))
          .ilike('unit', escapeIlikeValue(u))
      )
      const residentBatches = await Promise.all(residentPromises)
      const resMap = new Map<string, LookupResident>()
      for (const b of residentBatches) {
        for (const r of (b.data ?? [])) resMap.set(r.id, r as LookupResident)
      }
      const residents = Array.from(resMap.values())

      setLookupResults({ residents, vehicles })
      if (residents.length === 0 && vehicles.length === 0) {
        setLookupMessage(`No match for "${raw}".`)
      }
    } catch (e) {
      console.error('[Manager mobile] lookup failed', e)
      setLookupMessage((e as Error).message || 'Lookup failed. Try again.')
    } finally {
      setLookupBusy(false)
    }
  }

  // ── Gate render ───────────────────────────────────────────────────
  if (gateStatus === 'checking') {
    return <Shell><p style={{ color: C.muted, textAlign: 'center', marginTop: '40px' }}>Loading…</p></Shell>
  }
  if (gateStatus === 'unauthorized') {
    return <Shell><Message color={C.red}>You don&apos;t have access to this page.</Message><a href="/login" style={{ color: C.gold, fontSize: '13px', display: 'block', textAlign: 'center', marginTop: '16px' }}>← Login</a></Shell>
  }
  if (gateStatus === 'no_property') {
    return <Shell><Message color={C.red}>No property assigned to your role. Contact your administrator.</Message></Shell>
  }
  if (gateStatus === 'error') {
    return <Shell><Message color={C.red}>{gateMessage}</Message></Shell>
  }

  // ── Main render ───────────────────────────────────────────────────
  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', gap: '10px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: C.gold, fontSize: '18px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{property}</div>
          <div style={{ color: C.muted, fontSize: '11px' }}>Resident &amp; vehicle approvals · <a href="/manager" style={{ color: C.gold }}>Desktop view →</a></div>
        </div>
        <button
          onClick={() => setScreen(screen === 'queue' ? 'lookup' : 'queue')}
          style={{
            background: C.panel, color: C.gold, border: `1px solid ${C.gold}`,
            borderRadius: '8px', padding: '10px 14px', fontSize: '13px',
            fontWeight: 'bold', cursor: 'pointer', minWidth: '90px',
          }}
        >
          {screen === 'queue' ? 'Look up ▸' : '◂ Queue'}
        </button>
      </div>

      {propertyOptions.length > 1 && (
        <select
          value={property}
          onChange={e => setProperty(e.target.value)}
          style={{
            display: 'block', width: '100%', padding: '10px', marginBottom: '14px',
            background: C.panel, border: `1px solid ${C.border}`, borderRadius: '6px',
            color: C.text, fontSize: '13px',
          }}
        >
          {propertyOptions.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      )}

      {writeError && (
        <div style={{ background: C.redDark, border: `1px solid ${C.redBorder}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', color: C.red, fontSize: '12.5px' }}>
          {writeError}
        </div>
      )}

      {screen === 'queue' ? renderQueue() : renderLookup()}
    </Shell>
  )

  // ── Screen: Pending queue ─────────────────────────────────────────
  function renderQueue() {
    const total = pendingResidents.length + pendingVehicles.length
    return (
      <>
        <div style={{ background: C.goldSoft, border: `1px solid ${C.gold}`, borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', color: C.text, marginBottom: '4px' }}>
            <span>Residents awaiting approval</span>
            <b style={{ color: C.gold }}>{pendingResidents.length}</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', color: C.text }}>
            <span>Vehicles awaiting approval</span>
            <b style={{ color: C.gold }}>{pendingVehicles.length}</b>
          </div>
          {canApprove && total > 0 && (
            <button
              onClick={handleBulkApprove}
              disabled={bulkBusy}
              style={{
                display: 'block', width: '100%', marginTop: '12px',
                padding: '12px', background: C.gold, color: '#0f1117',
                border: 'none', borderRadius: '8px', fontWeight: 'bold',
                fontSize: '14px', cursor: bulkBusy ? 'wait' : 'pointer',
                opacity: bulkBusy ? 0.6 : 1,
              }}
            >
              {bulkBusy ? 'Approving…' : 'Approve all pending'}
            </button>
          )}
        </div>

        {bulkSummary && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
            <div style={{ color: C.gold, fontSize: '12px', fontWeight: 'bold', marginBottom: '6px' }}>Bulk approval complete</div>
            {bulkSummary.map((line, i) => (
              <div key={i} style={{ fontSize: '12.5px', color: C.text, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{line}</div>
            ))}
            <button onClick={() => setBulkSummary(null)} style={{ marginTop: '10px', background: 'transparent', color: C.muted, border: 'none', fontSize: '11px', cursor: 'pointer', padding: 0 }}>Dismiss</button>
          </div>
        )}

        {queueLoading && total === 0 && <p style={{ color: C.muted, textAlign: 'center', marginTop: '30px' }}>Loading…</p>}

        {!queueLoading && total === 0 && (
          <p style={{ color: C.muted, textAlign: 'center', marginTop: '40px', fontSize: '14px' }}>Nothing waiting.</p>
        )}

        {pendingResidents.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ color: C.muted, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Residents</div>
            {pendingResidents.map(r => (
              <Card key={r.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' }}>
                  <div style={{ color: C.text, fontSize: '14px', fontWeight: 'bold' }}>{r.name || '(no name)'}</div>
                  <div style={{ color: C.muted, fontSize: '12px' }}>Unit {r.unit || '?'}</div>
                </div>
                <div style={{ color: C.muted, fontSize: '11.5px', marginBottom: '10px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.email || ''}</div>
                <ButtonRow
                  canApprove={canApprove}
                  busy={busyResidentId === r.id}
                  onApprove={() => handleApproveResident(r)}
                  onDecline={() => handleDeclineResident(r)}
                />
              </Card>
            ))}
          </div>
        )}

        {pendingVehicles.length > 0 && (
          <div style={{ marginTop: '14px' }}>
            <div style={{ color: C.muted, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Vehicles</div>
            {pendingVehicles.map(v => (
              <Card key={v.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' }}>
                  <div style={{ color: C.gold, fontSize: '14px', fontWeight: 'bold', fontFamily: 'Courier New, monospace' }}>{v.plate || '(no plate)'}</div>
                  <div style={{ color: C.muted, fontSize: '12px' }}>Unit {v.unit || '?'}</div>
                </div>
                <div style={{ color: C.muted, fontSize: '11.5px', marginBottom: '2px' }}>{[v.make, v.model].filter(Boolean).join(' ')}{v.color ? ` · ${v.color}` : ''}</div>
                <div style={{ color: C.faint, fontSize: '11px', marginBottom: '10px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.resident_email || ''}</div>
                <ButtonRow
                  canApprove={canApprove}
                  busy={busyVehicleId === v.id}
                  onApprove={() => handleApproveVehicle(v)}
                  onDecline={() => handleDeclineVehicle(v)}
                />
              </Card>
            ))}
          </div>
        )}
      </>
    )
  }

  // ── Screen: Lookup ────────────────────────────────────────────────
  function renderLookup() {
    return (
      <>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            value={lookupInput}
            onChange={e => setLookupInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleLookup() }}
            placeholder="Unit or plate"
            style={{
              flex: 1, padding: '12px', background: C.panel,
              border: `1px solid ${C.border}`, borderRadius: '8px',
              color: C.text, fontSize: '14px',
            }}
          />
          <button
            onClick={handleLookup}
            disabled={lookupBusy || !lookupInput.trim()}
            style={{
              padding: '12px 18px', background: C.gold, color: '#0f1117',
              border: 'none', borderRadius: '8px', fontWeight: 'bold',
              fontSize: '13px', cursor: lookupBusy ? 'wait' : 'pointer',
              opacity: (lookupBusy || !lookupInput.trim()) ? 0.5 : 1,
            }}
          >
            {lookupBusy ? '…' : 'Search'}
          </button>
        </div>

        {lookupMessage && !lookupResults && (
          <p style={{ color: C.muted, textAlign: 'center', marginTop: '20px', fontSize: '13px' }}>{lookupMessage}</p>
        )}

        {lookupResults && (
          <>
            {lookupResults.residents.length > 0 && (
              <div style={{ marginBottom: '14px' }}>
                <div style={{ color: C.muted, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Residents</div>
                {lookupResults.residents.map(r => (
                  <Card key={r.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' }}>
                      <div style={{ color: C.text, fontSize: '14px', fontWeight: 'bold' }}>{r.name || '(no name)'}</div>
                      <div style={{ color: r.is_active ? C.green : C.muted, fontSize: '11.5px' }}>● {r.is_active ? 'Active' : 'Inactive'}</div>
                    </div>
                    <div style={{ color: C.muted, fontSize: '11.5px' }}>Unit {r.unit || '?'} · {r.email || ''}</div>
                  </Card>
                ))}
              </div>
            )}

            {lookupResults.vehicles.length > 0 && (
              <div>
                <div style={{ color: C.muted, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Vehicles</div>
                {lookupResults.vehicles.map(v => (
                  <Card key={v.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' }}>
                      <div style={{ color: C.gold, fontSize: '14px', fontWeight: 'bold', fontFamily: 'Courier New, monospace' }}>{v.plate || '(no plate)'}</div>
                      <div style={{ color: vehicleStatusColor(v), fontSize: '11.5px' }}>{vehicleStatusLabel(v)}</div>
                    </div>
                    <div style={{ color: C.muted, fontSize: '11.5px', marginBottom: '2px' }}>Unit {v.unit || '?'} · {[v.make, v.model].filter(Boolean).join(' ')}{v.color ? ` · ${v.color}` : ''}</div>
                    {v.status === 'pending' && canApprove && (
                      <div style={{ marginTop: '8px' }}>
                        <ButtonRow
                          canApprove={canApprove}
                          busy={busyVehicleId === v.id}
                          onApprove={() => handleApproveVehicle(v as unknown as PendingVehicle).then(() => handleLookup())}
                          onDecline={() => handleDeclineVehicle(v as unknown as PendingVehicle).then(() => handleLookup())}
                        />
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}

            {lookupResults.residents.length === 0 && lookupResults.vehicles.length === 0 && (
              <p style={{ color: C.muted, textAlign: 'center', marginTop: '20px', fontSize: '13px' }}>{lookupMessage || 'No match.'}</p>
            )}
          </>
        )}
      </>
    )
  }
}

// ── Small helpers ────────────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{
      minHeight: '100vh', background: '#0f1117',
      fontFamily: 'Arial, sans-serif', padding: '14px',
      color: '#e8e8e8',
    }}>
      <div style={{ maxWidth: '540px', margin: '0 auto' }}>{children}</div>
    </main>
  )
}

function Message({ children, color }: { children: React.ReactNode; color: string }) {
  return <p style={{ color, textAlign: 'center', marginTop: '40px', fontSize: '14px', lineHeight: 1.5 }}>{children}</p>
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: '#1e2535', border: '1px solid #3a4055',
      borderRadius: '10px', padding: '12px', marginBottom: '10px',
    }}>{children}</div>
  )
}

function ButtonRow({ canApprove, busy, onApprove, onDecline }: {
  canApprove: boolean; busy: boolean; onApprove: () => void; onDecline: () => void
}) {
  // Touch targets: 44px min height (Apple HIG). Approve and decline
  // separated by an 8px gap to reduce mis-tap risk on the walking-manager
  // surface — per Mateo's real-device verification concerns.
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      {canApprove && (
        <button
          onClick={onApprove}
          disabled={busy}
          style={{
            flex: 1, minHeight: '44px', padding: '10px',
            background: '#1a3a1a', color: '#4caf50',
            border: '1px solid #2e7d32', borderRadius: '8px',
            cursor: busy ? 'wait' : 'pointer',
            fontSize: '13px', fontWeight: 'bold',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? '…' : 'Approve'}
        </button>
      )}
      <button
        onClick={onDecline}
        disabled={busy}
        style={{
          flex: 1, minHeight: '44px', padding: '10px',
          background: '#3a1a1a', color: '#f44336',
          border: '1px solid #b71c1c', borderRadius: '8px',
          cursor: busy ? 'wait' : 'pointer',
          fontSize: '13px', fontWeight: 'bold',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? '…' : 'Decline'}
      </button>
    </div>
  )
}

// Friendly error copy — raw JS/server error strings NEVER reach the user
// (memory: feedback_raw_error_never_reaches_user.md). console.error keeps
// the raw string for diagnostics; this returns a message the manager can
// actually act on.
function friendlyWriteError(e: unknown, action: 'single' | 'bulk-preflight-failed' | 'bulk-mid-batch'): string {
  const err = e as Error
  const msg = err?.message || ''
  const isNetwork = e instanceof TypeError
    || /Load failed|Failed to fetch|NetworkError|network|ECONNREFUSED|timeout/i.test(msg)
  switch (action) {
    case 'single':
      return isNetwork
        ? "Couldn't reach the server. Check your connection and try again."
        : 'Action failed. Try again.'
    case 'bulk-preflight-failed':
      // Verifiable: only the pre-phase-1 fetch inside runBulkApprove failed.
      // No writes were attempted. The "nothing was changed" copy is load-
      // bearing here — it answers the manager's exact question.
      return "Couldn't load the current state. Check your connection and try again — nothing was changed."
    case 'bulk-mid-batch':
      // Writes may have partially completed. Copy references the refetch
      // so the visible state matches the message.
      return isNetwork
        ? 'Connection dropped during the bulk approve. Some approvals may have gone through — the queue has been refreshed to show what actually landed.'
        : 'Bulk approve had a problem. The queue has been refreshed to show what actually landed.'
  }
}

function vehicleStatusLabel(v: LookupVehicle): string {
  if (v.status === 'active' && v.is_active) return '● Approved'
  if (v.status === 'pending') return '● Pending approval'
  if (v.status === 'declined') return '● Declined'
  if (!v.is_active) return '● Inactive'
  return `● ${v.status || 'unknown'}`
}

function vehicleStatusColor(v: LookupVehicle): string {
  if (v.status === 'active' && v.is_active) return '#4caf50'
  if (v.status === 'pending') return '#C9A227'
  if (v.status === 'declined' || !v.is_active) return '#888'
  return '#888'
}

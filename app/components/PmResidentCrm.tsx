'use client'
// PM Resident CRM — read-only shell (Slice 1)
// Actions land in later slices (2: approvals · 3: spaces · 4: plate re-approval ·
// 5: deactivate/release · 6: inline edit · 7: permit insight).
//
// Anti-N+1 contract: this component receives already-grouped CrmResident[]
// from the parent. Zero DB access here; grouping done in app/lib/pm-crm.ts.

import { useMemo, useState } from 'react'
import type { CrmResident, CrmFilter, CrmResidentSpace, CrmSpace } from '@/app/lib/pm-crm'
import { computeInsights, filterCrmRows, initials } from '@/app/lib/pm-crm'

type SubTab = 'overview' | 'vehicles' | 'spaces' | 'guests' | 'activity'

interface Props {
  crmResidents: CrmResident[]
  propertyName: string
  managerEmail: string
  // Slice 3.5 — available-spaces pool for the "Assign space" picker on
  // pending space requests. Sourced from crmSpacesAtProperty filtered
  // client-side to status='available' + is_active.
  availableSpaces: Array<Pick<CrmSpace, 'id' | 'label' | 'type'>>
  // Slice 2 — permission gate (mirrors legacy 4 approve-affordance sites)
  // + read-only mode for leasing_agent (Decline stays visible regardless
  // per legacy).
  canApproveVehicles: boolean
  isReadOnly: boolean
  // Slice 2 callbacks — parent owns state + meter accounting.
  //   Per-vehicle Approve → parent's approveVehicle wrapper (1 sync).
  //   Per-resident Approve → parent's approveResident wrapper (RPC direct
  //     loop + 1 sync).
  //   Bulk Approve-all → parent's approveAllPendingCrm (RPC direct loop
  //     + 1 sync, no per-resident sync).
  //   Decline paths → parent's declineVehicle / declineResident.
  onApproveVehicle: (vehicleId: string | number) => Promise<void>
  onDeclineVehicle: (vehicleId: string | number) => Promise<void>
  onApproveResident: (resident: CrmResident) => Promise<void>
  onDeclineResident: (resident: CrmResident) => Promise<void>
  onApproveAllPending: (pendingResidents: CrmResident[]) => Promise<void>
  // Slice 3 — space handlers. All server-role-gated (manager|CA); client
  // hides on isReadOnly. Release uses per-tie free_space so co-residents
  // survive.
  onReleaseSpace: (spaceId: number, residentEmail: string) => Promise<void>
  onAssignSpaceRequest: (requestId: number, spaceId: number) => Promise<void>
  onDeclineSpaceRequest: (requestId: number) => Promise<void>
  // Slice 4 — plate re-approval handlers. Approve gated on
  // canApproveVehicles (permit-granting rule); Decline role-only per
  // Jose's standing rule. Meter-none: neither callback fires
  // callSyncOnAdd — a plate change is a substitution, not a new permit.
  onApprovePlateChange: (changeId: number) => Promise<void>
  onDeclinePlateChange: (changeId: number) => Promise<void>
}

// Manager-portal design tokens (matched to existing manager/page.tsx palette).
const C = {
  bg: '#0f1117',
  panel: '#161b26',
  panel2: '#1e2535',
  border: '#2a2f3d',
  border2: '#3a4055',
  gold: '#C9A227',
  goldSoft: 'rgba(201,162,39,0.14)',
  goldLine: 'rgba(201,162,39,0.4)',
  amber: '#f0a340',
  amberSoft: 'rgba(224,145,47,0.15)',
  amberLine: '#a16207',
  green: '#5fd08a',
  greenSoft: 'rgba(46,160,90,0.15)',
  greenLine: '#2e7d32',
  red: '#df7676',
  redSoft: 'rgba(180,64,64,0.15)',
  redLine: '#b71c1c',
  blue: '#6fb2e0',
  blueSoft: 'rgba(80,150,210,0.14)',
  text: '#f2f3f5',
  muted: '#8b919e',
  faint: '#5a606c',
}

const chipBase: React.CSSProperties = {
  padding: '5px 10px', borderRadius: '20px', fontSize: '12px', cursor: 'pointer',
  border: `1px solid ${C.border2}`, color: C.muted, background: 'transparent',
  fontFamily: 'inherit',
}
const chipOn: React.CSSProperties = {
  ...chipBase, borderColor: C.goldLine, background: C.goldSoft, color: C.gold, fontWeight: 600,
}

// Shared plate-chip style — every CRM site that renders a plate as a
// license-plate-shaped chip (dark fill, mono text) reuses this. Explicit
// `color: C.text` — dark fill + inherited color was the contrast bug in
// slice 2 (JO3M4M4 unreadable until selected). Any future plate chip in
// slice 3+ (roommate rows use inline mono, not chips; slice 4 plate-
// re-approval renders old→new chips) should spread this.
const plateChipStyle: React.CSSProperties = {
  fontFamily: 'Courier New',
  fontWeight: 800,
  fontSize: '16px',
  letterSpacing: '1px',
  color: C.text,
  background: '#0e1015',
  border: `1.5px solid ${C.border2}`,
  borderRadius: '6px',
  padding: '5px 11px',
  display: 'inline-block',
}

export default function PmResidentCrm({
  crmResidents, propertyName, availableSpaces,
  canApproveVehicles, isReadOnly,
  onApproveVehicle, onDeclineVehicle,
  onApproveResident, onDeclineResident,
  onApproveAllPending,
  onReleaseSpace, onAssignSpaceRequest, onDeclineSpaceRequest,
  onApprovePlateChange, onDeclinePlateChange,
}: Props) {
  const [filter, setFilter] = useState<CrmFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedEmail, setSelectedEmail] = useState<string | null>(
    crmResidents[0]?.email ?? null
  )
  const [subTab, setSubTab] = useState<SubTab>('overview')

  const insights = useMemo(() => computeInsights(crmResidents), [crmResidents])
  const filtered = useMemo(() => filterCrmRows(crmResidents, filter, search), [crmResidents, filter, search])
  const selected = useMemo(
    () => crmResidents.find(r => r.email.toLowerCase() === (selectedEmail ?? '').toLowerCase()) ?? null,
    [crmResidents, selectedEmail]
  )
  const needsApprovalResidents = useMemo(
    () => crmResidents.filter(r => r.status === 'pending'),
    [crmResidents]
  )

  return (
    <div>
      {/* ── Insights strip (5 columns; 2 on mobile) ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '14px',
      }}>
        <InsightCard n={insights.needApproval} label="Need approval" color={C.gold} />
        <InsightCard n={insights.spaceRequests} label="Space requests" color={C.text} />
        <InsightCard n={insights.platesUnderReview} label="Plates under review" color={C.amber} />
        <InsightCard n={insights.activeResidents} label="Active residents" color={C.green} />
        <InsightCard
          n={insights.approvedPermits}
          label={<>Approved permits <span style={{ color: C.faint, fontSize: '10.5px' }}>· metered*</span></>}
          color={C.gold}
        />
      </div>

      {/* ── CRM grid: left list + right detail ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '370px 1fr', gap: '16px' }}>

        {/* ── Left: list ── */}
        <div style={{
          background: C.panel, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden',
          alignSelf: 'start',
        }}>
          <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
              <h2 style={{ margin: 0, fontSize: '15px', color: C.text }}>Residents</h2>
              <span style={{ color: C.faint, fontSize: '12px' }}>
                {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
              </span>
            </div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, email, unit, plate…"
              style={{
                width: '100%', background: C.panel2, border: `1px solid ${C.border2}`, borderRadius: '9px',
                padding: '9px 11px', color: C.text, fontSize: '13px', fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
              {(['all', 'active', 'needs', 'review'] as CrmFilter[]).map(f => (
                <div key={f} onClick={() => setFilter(f)} style={filter === f ? chipOn : chipBase}>
                  {f === 'needs' && <span style={{
                    display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%',
                    background: C.amber, marginRight: '5px',
                  }} />}
                  {f === 'all' ? 'All' : f === 'active' ? 'Active' : f === 'needs' ? 'Needs approval' : 'Plate under review'}
                </div>
              ))}
            </div>
          </div>

          {/* Bulk lane — visible when filter="needs" and there's approval work.
              Gated on canApproveVehicles (per Jose slice-2 rule: the bulk lane
              is the easiest gate to forget). Delegates to onApproveAllPending
              — parent's approveAllPendingCrm handles meter-once accounting
              (RPC direct loop + ONE sync). */}
          {filter === 'needs' && insights.needApproval > 0 && !isReadOnly && canApproveVehicles && (
            <div style={{
              margin: '11px 14px 0', padding: '10px 12px',
              border: `1px solid ${C.goldLine}`, background: C.goldSoft, borderRadius: '9px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
            }}>
              <div style={{ fontSize: '12.5px', color: C.gold }}>
                <b>{insights.needApproval}</b> residents with pending items
              </div>
              <button onClick={() => onApproveAllPending(needsApprovalResidents)} style={{
                padding: '6px 12px', background: C.gold, color: '#0f1117', border: 'none',
                borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontWeight: 700, fontFamily: 'inherit',
              }}>
                Approve all pending
              </button>
            </div>
          )}

          <div style={{ maxHeight: '600px', overflow: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '44px 20px', textAlign: 'center', color: C.faint }}>
                <div style={{ fontSize: '15px', color: C.muted, marginBottom: '5px' }}>No residents match</div>
                Try a different filter or search.
              </div>
            ) : filtered.map(r => (
              <ListRow
                key={r.id}
                resident={r}
                selected={r.email.toLowerCase() === (selectedEmail ?? '').toLowerCase()}
                onClick={() => { setSelectedEmail(r.email); setSubTab('overview') }}
              />
            ))}
          </div>
        </div>

        {/* ── Right: detail ── */}
        <div style={{
          background: C.panel, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden',
          minHeight: '600px',
        }}>
          {!selected ? (
            <EmptyDetail />
          ) : (
            <>
              <DetailHeader
                resident={selected}
                canApproveVehicles={canApproveVehicles}
                isReadOnly={isReadOnly}
                onApproveResident={onApproveResident}
                onDeclineResident={onDeclineResident}
              />
              <FactsStrip resident={selected} />
              <SubTabBar tab={subTab} setTab={setSubTab} resident={selected} />
              <div style={{ padding: '16px' }}>
                {subTab === 'overview' && (
                  <OverviewPane
                    resident={selected}
                    canApproveVehicles={canApproveVehicles}
                    isReadOnly={isReadOnly}
                    onApproveResident={onApproveResident}
                    onDeclineResident={onDeclineResident}
                    onJumpToGuests={() => setSubTab('guests')}
                  />
                )}
                {subTab === 'vehicles' && (
                  <VehiclesPane
                    resident={selected}
                    canApproveVehicles={canApproveVehicles}
                    isReadOnly={isReadOnly}
                    onApproveVehicle={onApproveVehicle}
                    onDeclineVehicle={onDeclineVehicle}
                    onApprovePlateChange={onApprovePlateChange}
                    onDeclinePlateChange={onDeclinePlateChange}
                  />
                )}
                {subTab === 'spaces' && (
                  <SpacesPane
                    resident={selected}
                    isReadOnly={isReadOnly}
                    availableSpaces={availableSpaces}
                    onReleaseSpace={onReleaseSpace}
                    onAssignSpaceRequest={onAssignSpaceRequest}
                    onDeclineSpaceRequest={onDeclineSpaceRequest}
                  />
                )}
                {subTab === 'guests' && <GuestsPane resident={selected} />}
                {subTab === 'activity' && <ActivityPane resident={selected} />}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{
        maxWidth: '1300px', margin: '18px auto 0', padding: '11px 16px',
        border: `1px dashed ${C.border2}`, borderRadius: '10px',
        color: C.faint, fontSize: '12px', background: 'rgba(201,162,39,0.03)',
      }}>
        <b style={{ color: C.gold }}>Slice 2 shipped.</b> Approve / Decline live (per-vehicle, per-resident cascade, bulk).
        Remaining: Spaces multi/roommate/release (slice 3) · Plate re-approval (slice 4) · Deactivate (slice 5) · Inline edit (slice 6).
        Property: <b>{propertyName}</b>. <span style={{ color: C.faint }}>*Approved permits = billed meter on PM-Only plans; activity metric on other tracks.</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────

function InsightCard({ n, label, color }: { n: number; label: React.ReactNode; color: string }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '12px 14px',
    }}>
      <div style={{ fontSize: '22px', fontWeight: 800, lineHeight: 1, color }}>{n}</div>
      <div style={{ color: C.muted, fontSize: '11.5px', marginTop: '5px' }}>{label}</div>
    </div>
  )
}

function ListRow({ resident, selected, onClick }: { resident: CrmResident; selected: boolean; onClick: () => void }) {
  const { approved, pending, underReview } = resident.vehicleCounts
  const badges: React.ReactNode[] = []
  if (approved) badges.push(<Badge key="ok" color={C.green} bg={C.greenSoft}>✓ {approved}</Badge>)
  if (pending) badges.push(<Badge key="pn" color={C.gold} bg={C.goldSoft}>• {pending} pending</Badge>)
  if (underReview) badges.push(<Badge key="rv" color={C.amber} bg={C.amberSoft}>⚠ {underReview} review</Badge>)
  if (resident.spaceRequest) badges.push(<Badge key="sq" color={C.blue} bg={C.blueSoft}>◇ space req</Badge>)
  if (!approved && !pending && !underReview && !resident.spaceRequest) {
    badges.push(<Badge key="nv" color={C.faint} bg="transparent">no vehicles</Badge>)
  }
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', gap: '11px', alignItems: 'center',
        padding: '12px 14px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
        borderLeft: `3px solid ${selected ? C.gold : 'transparent'}`,
        background: selected ? C.panel2 : 'transparent',
      }}
    >
      <div style={{
        width: '34px', height: '34px', borderRadius: '9px', background: '#262b36',
        display: 'grid', placeItems: 'center', fontWeight: 700, color: C.gold, fontSize: '13px', flex: 'none',
      }}>{initials(resident.name)}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '13.5px', color: C.text }}>{resident.name}</div>
        <div style={{
          color: C.faint, fontSize: '11.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>Unit {resident.unit} · {resident.email}</div>
        <div style={{ display: 'flex', gap: '5px', marginTop: '5px', flexWrap: 'wrap' }}>{badges}</div>
      </div>
      <StatusPill status={resident.status} />
    </div>
  )
}

function Badge({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: '10.5px', padding: '2px 7px', borderRadius: '20px', fontWeight: 700,
      color, background: bg, display: 'inline-flex', gap: '4px', alignItems: 'center',
    }}>{children}</span>
  )
}

function StatusPill({ status }: { status: CrmResident['status'] }) {
  const cfg = status === 'active'
    ? { color: C.green, bg: C.greenSoft, border: C.greenLine, text: 'Active' }
    : status === 'pending'
      ? { color: C.gold, bg: C.goldSoft, border: C.goldLine, text: 'Pending' }
      : { color: C.red, bg: C.redSoft, border: C.redLine, text: 'Declined' }
  return (
    <span style={{
      fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', flex: 'none',
      color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
    }}>{cfg.text}</span>
  )
}

function EmptyDetail() {
  return (
    <div style={{ padding: '80px 20px', textAlign: 'center', color: C.faint }}>
      <div style={{ fontSize: '15px', color: C.muted, marginBottom: '5px' }}>Select a resident</div>
      Pick someone from the list to see their profile.
    </div>
  )
}

function DetailHeader({ resident, canApproveVehicles, isReadOnly, onApproveResident, onDeclineResident }: {
  resident: CrmResident
  canApproveVehicles: boolean
  isReadOnly: boolean
  onApproveResident: (r: CrmResident) => Promise<void>
  onDeclineResident: (r: CrmResident) => Promise<void>
}) {
  const showApprove = resident.status === 'pending' && canApproveVehicles && !isReadOnly
  const showDecline = resident.status === 'pending' && !isReadOnly
  return (
    <div style={{ padding: '18px 20px 16px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '14px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '13px', alignItems: 'center' }}>
          <div style={{
            width: '46px', height: '46px', fontSize: '17px', borderRadius: '11px',
            background: '#262b36', display: 'grid', placeItems: 'center', fontWeight: 700, color: C.gold, flex: 'none',
          }}>{initials(resident.name)}</div>
          <div>
            <h2 style={{ margin: 0, fontSize: '19px', color: C.text, display: 'flex', alignItems: 'center', gap: '10px' }}>
              {resident.name}
              <StatusPill status={resident.status} />
            </h2>
            <div style={{ color: C.muted, fontSize: '12.5px', marginTop: '3px' }}>
              Unit {resident.unit} · {resident.email}
              {resident.phone && ` · ${resident.phone}`}
            </div>
          </div>
        </div>
        {(showApprove || showDecline) && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {showApprove && (
              <button onClick={() => onApproveResident(resident)} title="Cascades to pending vehicles" style={{
                padding: '8px 14px', background: C.greenSoft, color: C.green,
                border: `1px solid ${C.greenLine}`, borderRadius: '6px',
                cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
              }}>Approve resident</button>
            )}
            {showDecline && (
              <button onClick={() => onDeclineResident(resident)} style={{
                padding: '8px 14px', background: C.redSoft, color: C.red,
                border: `1px solid ${C.redLine}`, borderRadius: '6px',
                cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
              }}>Decline</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FactsStrip({ resident }: { resident: CrmResident }) {
  const spaceLabels = resident.assignedSpaces.map(s => s.label).join(', ') || '—'
  const vsum = [
    resident.vehicleCounts.approved && `${resident.vehicleCounts.approved} approved`,
    resident.vehicleCounts.pending && `${resident.vehicleCounts.pending} pending`,
    resident.vehicleCounts.underReview && `${resident.vehicleCounts.underReview} under review`,
  ].filter(Boolean).join(' · ') || 'none on file'
  const regDate = resident.created_at ? new Date(resident.created_at).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  }) : '—'
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1px', background: C.border,
      borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
    }}>
      <Fact k={<>Assigned space(s) <SrcTag /></>} v={spaceLabels === '—' ? <span style={{ color: C.faint }}>—</span> : spaceLabels} />
      <Fact k="Vehicles" v={vsum} />
      <Fact k="Lease end" v={resident.lease_end || <span style={{ color: C.faint }}>—</span>} />
      <Fact k="Registered" v={regDate} />
    </div>
  )
}

function Fact({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div style={{ background: C.panel, padding: '13px 16px' }}>
      <div style={{
        color: C.faint, fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.6px',
        marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '5px',
      }}>{k}</div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: C.text }}>{v}</div>
    </div>
  )
}

function SrcTag() {
  return (
    <span style={{
      fontSize: '9px', color: C.faint, border: `1px solid ${C.border2}`,
      borderRadius: '5px', padding: '1px 4px', textTransform: 'none', letterSpacing: 0, fontWeight: 600,
    }}>spaces table</span>
  )
}

function SubTabBar({ tab, setTab, resident }: { tab: SubTab; setTab: (t: SubTab) => void; resident: CrmResident }) {
  const pendCount = resident.vehicleCounts.pending + (resident.spaceRequest ? 1 : 0) + resident.vehicleCounts.underReview
  const tabs: Array<{ id: SubTab; label: string; badge?: number; hot?: boolean }> = [
    { id: 'overview', label: 'Overview', badge: pendCount, hot: pendCount > 0 },
    { id: 'vehicles', label: 'Vehicles', badge: resident.vehicles.length },
    { id: 'spaces', label: 'Spaces', badge: resident.spaceRequest ? 1 : undefined, hot: !!resident.spaceRequest },
    { id: 'guests', label: 'Guests', badge: resident.guests.length },
    { id: 'activity', label: 'Activity' },
  ]
  return (
    <div style={{ display: 'flex', gap: '4px', padding: '12px 16px 0', overflow: 'auto' }}>
      {tabs.map(t => (
        <div key={t.id} onClick={() => setTab(t.id)} style={{
          padding: '9px 13px', borderRadius: '8px 8px 0 0', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
          color: tab === t.id ? C.gold : C.muted,
          borderBottom: tab === t.id ? `2px solid ${C.gold}` : 'none',
          whiteSpace: 'nowrap',
        }}>
          {t.label}
          {t.badge != null && t.badge > 0 && (
            <span style={{
              display: 'inline-grid', placeItems: 'center', minWidth: '15px', height: '15px', padding: '0 3px',
              marginLeft: '4px', borderRadius: '8px', fontSize: '9.5px', fontWeight: 800, verticalAlign: 'middle',
              background: t.hot ? '#c0392b' : '#262b36', color: t.hot ? '#fff' : C.muted,
            }}>{t.badge}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Sub-tab panes ────────────────────────────────────────────────────

function OverviewPane({ resident, canApproveVehicles, isReadOnly, onApproveResident, onDeclineResident, onJumpToGuests }: {
  resident: CrmResident
  canApproveVehicles: boolean
  isReadOnly: boolean
  onApproveResident: (r: CrmResident) => Promise<void>
  onDeclineResident: (r: CrmResident) => Promise<void>
  onJumpToGuests: () => void
}) {
  const { pending, underReview } = resident.vehicleCounts
  const showCallout = resident.needsApproval
  const showApproveResident = resident.status === 'pending' && canApproveVehicles && !isReadOnly
  const showDeclineResident = resident.status === 'pending' && !isReadOnly
  return (
    <>
      {showCallout && (
        <div style={{
          border: `1px solid ${C.goldLine}`, background: C.goldSoft, borderRadius: '10px',
          padding: '12px 14px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', gap: '12px', flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: '13px', color: C.text }}>
            <b style={{ color: C.gold }}>Action needed.</b>{' '}
            {resident.status === 'pending' && 'New registration awaiting approval. '}
            {pending > 0 && `${pending} vehicle${pending === 1 ? '' : 's'} pending. `}
            {resident.spaceRequest && '1 space request. '}
            {underReview > 0 && `${underReview} plate${underReview === 1 ? '' : 's'} under review.`}
          </div>
          {(showApproveResident || showDeclineResident) && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {showApproveResident && (
                <button onClick={() => onApproveResident(resident)} title="Cascades to pending vehicles" style={{
                  padding: '7px 12px', background: C.greenSoft, color: C.green,
                  border: `1px solid ${C.greenLine}`, borderRadius: '6px',
                  cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
                }}>Approve resident</button>
              )}
              {showDeclineResident && (
                <button onClick={() => onDeclineResident(resident)} style={{
                  padding: '7px 12px', background: C.redSoft, color: C.red,
                  border: `1px solid ${C.redLine}`, borderRadius: '6px',
                  cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
                }}>Decline</button>
              )}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '14px' }}>
        <Card title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>Authorized guests</span>
            {resident.guests.length > 0 && (
              <button onClick={onJumpToGuests} style={{
                background: 'transparent', border: 'none', color: C.gold, fontSize: '11px',
                fontFamily: 'inherit', cursor: 'pointer', padding: 0, letterSpacing: 'normal', textTransform: 'none',
              }}>→ Guests</button>
            )}
          </div>
        }>
          {resident.guests.length === 0 ? (
            <div style={{ color: C.faint, fontSize: '12.5px' }}>None on file.</div>
          ) : (
            <>
              <div style={{ color: C.text, fontSize: '13px', marginBottom: '4px' }}>
                <b>{resident.guests.length}</b> {resident.guests.length === 1 ? 'guest' : 'guests'} on file
              </div>
              <div style={{ color: C.muted, fontSize: '12px' }}>
                {resident.guests.slice(0, 2).map(g => (g as any).guest_name || (g as any).name || '(unnamed)').filter(Boolean).join(' · ')}
                {resident.guests.length > 2 && ` · +${resident.guests.length - 2} more`}
              </div>
            </>
          )}
        </Card>
        <Card title="Notes">
          <div style={{
            width: '100%', background: C.panel2, border: `1px solid ${C.border2}`, borderRadius: '9px',
            padding: '11px', color: C.text, fontFamily: 'inherit', fontSize: '13px', minHeight: '64px',
          }}>
            {resident.manager_note || <span style={{ color: C.faint }}>No notes.</span>}
          </div>
          <div style={{ fontSize: '11px', color: C.faint, marginTop: '8px', fontStyle: 'italic' }}>
            Edit lands slice 6.
          </div>
        </Card>
      </div>
    </>
  )
}

function VehiclesPane({ resident, canApproveVehicles, isReadOnly, onApproveVehicle, onDeclineVehicle, onApprovePlateChange, onDeclinePlateChange }: {
  resident: CrmResident
  canApproveVehicles: boolean
  isReadOnly: boolean
  onApproveVehicle: (id: string | number) => Promise<void>
  onDeclineVehicle: (id: string | number) => Promise<void>
  onApprovePlateChange: (changeId: number) => Promise<void>
  onDeclinePlateChange: (changeId: number) => Promise<void>
}) {
  if (resident.vehicles.length === 0) {
    return (
      <div style={{ padding: '44px 20px', textAlign: 'center', color: C.faint }}>
        <div style={{ fontSize: '15px', color: C.muted, marginBottom: '5px' }}>No vehicles on file</div>
        This resident hasn't submitted a vehicle yet.
      </div>
    )
  }
  return (
    <>
      {resident.vehicles.map(v => (
        <VehicleCard
          key={v.id} v={v}
          canApproveVehicles={canApproveVehicles}
          isReadOnly={isReadOnly}
          onApproveVehicle={onApproveVehicle}
          onDeclineVehicle={onDeclineVehicle}
          onApprovePlateChange={onApprovePlateChange}
          onDeclinePlateChange={onDeclinePlateChange}
        />
      ))}
      <div style={{ fontSize: '11px', color: C.faint, marginTop: '10px', fontStyle: 'italic' }}>
        Deactivate lands slice 5.
      </div>
    </>
  )
}

function VehicleCard({ v, canApproveVehicles, isReadOnly, onApproveVehicle, onDeclineVehicle, onApprovePlateChange, onDeclinePlateChange }: {
  v: any
  canApproveVehicles: boolean
  isReadOnly: boolean
  onApproveVehicle: (id: string | number) => Promise<void>
  onDeclineVehicle: (id: string | number) => Promise<void>
  onApprovePlateChange: (changeId: number) => Promise<void>
  onDeclinePlateChange: (changeId: number) => Promise<void>
}) {
  const s = (v.status ?? '').toLowerCase()
  const stat = s === 'under_review'
    ? { color: C.amber, bg: C.amberSoft, border: '#a16207', text: 'Plate under review' }
    : s === 'pending'
      ? { color: C.gold, bg: C.goldSoft, border: C.goldLine, text: 'Pending approval' }
      : s === 'active' || s === 'approved'
        ? { color: C.green, bg: C.greenSoft, border: C.greenLine, text: 'Approved' }
        : { color: C.faint, bg: 'transparent', border: C.border, text: (v.status || 'unknown') }
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ') || '—'
  const status = (v.status ?? '').toLowerCase()
  const isPending = status === 'pending'
  const isUnderReview = status === 'under_review'
  const showApprove = isPending && canApproveVehicles && !isReadOnly
  const showDecline = isPending && !isReadOnly
  // Slice 4 — plate re-approval affordances. pendingPlateChange is
  // attached by buildCrmResidents Phase 3 when the vehicle has a
  // vehicle_plate_changes row with status='pending'.
  const pc = v.pendingPlateChange
  const showApprovePlateChange = isUnderReview && !!pc && canApproveVehicles && !isReadOnly
  const showDeclinePlateChange = isUnderReview && !!pc && !isReadOnly
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px',
      marginBottom: '12px', background: C.panel2,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
        <div>
          <div style={plateChipStyle}>{v.plate}</div>
          <div style={{ color: C.muted, fontSize: '12.5px', marginTop: '7px' }}>
            {ymm}{v.color && ` · ${v.color}`}
          </div>
        </div>
        <span style={{
          fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '20px',
          color: stat.color, background: stat.bg, border: `1px solid ${stat.border}`, whiteSpace: 'nowrap',
        }}>{stat.text}</span>
      </div>
      {(showApprove || showDecline) && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          {showApprove && (
            <button onClick={() => onApproveVehicle(v.id)} style={{
              flex: 1, padding: '8px', background: C.greenSoft, color: C.green,
              border: `1px solid ${C.greenLine}`, borderRadius: '6px',
              cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
            }}>Approve</button>
          )}
          {showDecline && (
            <button onClick={() => onDeclineVehicle(v.id)} style={{
              flex: showApprove ? 1 : undefined, padding: '8px 14px', background: C.redSoft, color: C.red,
              border: `1px solid ${C.redLine}`, borderRadius: '6px',
              cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
            }}>Decline</button>
          )}
        </div>
      )}
      {/* Slice 4 — Do-Not-Tow banner + old→new plates + Approve new/Keep current.
          Renders only when the vehicle is under_review AND a pendingPlateChange
          row is attached. The old plate stays enforce-valid until the PM decides
          (both DB invariant + driver plate lookup honor this). */}
      {isUnderReview && pc && (
        <>
          <div style={{
            marginTop: '12px', background: C.amberSoft, border: `1px solid ${C.amberLine}`,
            borderRadius: '8px', padding: '10px 12px', fontSize: '12.5px', display: 'flex',
            gap: '9px', alignItems: 'flex-start',
          }}>
            <span style={{ color: C.amber, fontSize: '15px', marginTop: '1px' }}>⚠</span>
            <div>
              <b style={{ color: C.amber }}>Do not tow — plate change under review.</b>{' '}
              <span style={{ color: C.text }}>
                The prior plate stays valid until you decide. Old → new:
              </span>
              <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ ...plateChipStyle, opacity: 0.55, textDecoration: 'line-through', fontSize: '13px' }}>{pc.old_plate}</div>
                <span style={{ color: C.amber, fontWeight: 800, fontSize: '18px' }}>→</span>
                <div style={{ ...plateChipStyle, fontSize: '13px' }}>{pc.new_plate}</div>
                <span style={{ color: C.faint, fontSize: '11px' }}>
                  submitted {new Date(pc.submitted_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
          {(showApprovePlateChange || showDeclinePlateChange) && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              {showApprovePlateChange && (
                <button onClick={() => onApprovePlateChange(pc.id)} title="Substitutes the new plate on this vehicle. No permit charge — substitution, not a new permit." style={{
                  flex: 1, padding: '8px', background: C.greenSoft, color: C.green,
                  border: `1px solid ${C.greenLine}`, borderRadius: '6px',
                  cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
                }}>Approve new plate</button>
              )}
              {showDeclinePlateChange && (
                <button onClick={() => onDeclinePlateChange(pc.id)} style={{
                  flex: showApprovePlateChange ? 1 : undefined, padding: '8px 14px', background: C.redSoft, color: C.red,
                  border: `1px solid ${C.redLine}`, borderRadius: '6px',
                  cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
                }}>Keep current plate</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SpacesPane({ resident, isReadOnly, availableSpaces, onReleaseSpace, onAssignSpaceRequest, onDeclineSpaceRequest }: {
  resident: CrmResident
  isReadOnly: boolean
  availableSpaces: Array<Pick<CrmSpace, 'id' | 'label' | 'type'>>
  onReleaseSpace: (spaceId: number, residentEmail: string) => Promise<void>
  onAssignSpaceRequest: (requestId: number, spaceId: number) => Promise<void>
  onDeclineSpaceRequest: (requestId: number) => Promise<void>
}) {
  const hasSpaces = resident.assignedSpaces.length > 0
  return (
    <>
      <div style={{
        fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.6px',
        color: C.faint, margin: '2px 0 10px', fontWeight: 700,
      }}>Assigned space(s)</div>
      {!hasSpaces && (
        <div style={{ color: C.faint, fontSize: '12.5px', marginBottom: '12px' }}>No space assigned.</div>
      )}
      {resident.assignedSpaces.map(s => (
        <SpaceCard
          key={s.id} s={s}
          residentEmail={resident.email}
          isReadOnly={isReadOnly}
          onReleaseSpace={onReleaseSpace}
        />
      ))}
      {resident.spaceRequest && (
        <SpaceRequestCard
          req={resident.spaceRequest}
          isReadOnly={isReadOnly}
          availableSpaces={availableSpaces}
          onAssignSpaceRequest={onAssignSpaceRequest}
          onDeclineSpaceRequest={onDeclineSpaceRequest}
        />
      )}
    </>
  )
}

function SpaceCard({ s, residentEmail, isReadOnly, onReleaseSpace }: {
  s: CrmResidentSpace
  residentEmail: string
  isReadOnly: boolean
  onReleaseSpace: (spaceId: number, residentEmail: string) => Promise<void>
}) {
  const roommateCount = s.roommateCount
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px',
      marginBottom: '12px', background: C.panel2,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px', flexWrap: 'wrap',
      }}>
        <div style={{ fontWeight: 600, fontSize: '13.5px', color: C.text }}>
          Space {s.label}{' '}
          <span style={{
            fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', marginLeft: '4px',
            color: C.green, background: C.greenSoft, border: `1px solid ${C.greenLine}`,
          }}>Assigned</span>
          {s.type && (
            <span style={{ color: C.faint, fontSize: '11px', marginLeft: '8px' }}>· {s.type}</span>
          )}
        </div>
        {!isReadOnly && (
          <button onClick={() => onReleaseSpace(s.id, residentEmail)} title="Frees this resident's tie for reassignment. Co-residents (if any) retain their tie." style={{
            padding: '6px 12px', background: C.redSoft, color: C.red,
            border: `1px solid ${C.redLine}`, borderRadius: '6px',
            cursor: 'pointer', fontSize: '11px', fontWeight: 700, fontFamily: 'inherit',
          }}>Release</button>
        )}
      </div>
      <div style={{
        fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.6px',
        color: C.faint, margin: '2px 0 8px', fontWeight: 700,
      }}>
        Plates authorized on this space
        {roommateCount > 0 && <span style={{ color: C.blue, textTransform: 'none', letterSpacing: 'normal', marginLeft: '6px', fontWeight: 600 }}>· shared with {roommateCount} other</span>}
      </div>
      {s.authorizedPlates.length === 0 ? (
        <div style={{ color: C.faint, fontSize: '12px' }}>No approved plates authorized on this space yet.</div>
      ) : s.authorizedPlates.map((p, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
        }}>
          <span style={{ fontSize: '12.5px' }}>
            <span style={{ fontFamily: 'Courier New', color: C.text, fontWeight: 600 }}>{p.plate}</span>
            <span style={{ color: C.muted }}> · {p.owner_name || p.owner_email}</span>
            {!p.isThisResident && p.owner_unit && (
              <span style={{ color: C.faint }}> · Unit {p.owner_unit}</span>
            )}
          </span>
          <span style={{
            fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', flex: 'none', whiteSpace: 'nowrap',
            color: p.isThisResident ? C.green : C.blue,
            background: p.isThisResident ? C.greenSoft : C.blueSoft,
          }}>{p.isThisResident ? 'this resident' : 'roommate'}</span>
        </div>
      ))}
    </div>
  )
}

function SpaceRequestCard({ req, isReadOnly, availableSpaces, onAssignSpaceRequest, onDeclineSpaceRequest }: {
  req: NonNullable<CrmResident['spaceRequest']>
  isReadOnly: boolean
  availableSpaces: Array<{ id: number; label: string; type: string | null }>
  onAssignSpaceRequest: (requestId: number, spaceId: number) => Promise<void>
  onDeclineSpaceRequest: (requestId: number) => Promise<void>
}) {
  const [pickedSpaceId, setPickedSpaceId] = useState<string>('')
  const canDecline = !isReadOnly
  const canAssign = !isReadOnly && availableSpaces.length > 0 && pickedSpaceId !== ''
  return (
    <div style={{
      border: `1px solid ${C.goldLine}`, borderRadius: '10px', padding: '12px 14px',
      marginBottom: '10px', background: C.goldSoft,
    }}>
      <div style={{ fontWeight: 600, fontSize: '13.5px', color: C.text }}>
        Space request from resident
      </div>
      <div style={{ color: C.muted, fontSize: '12px', marginTop: '2px' }}>
        Requested {new Date(req.requested_at).toLocaleDateString()} · awaiting decision
      </div>
      {req.note && (
        <div style={{ color: C.muted, fontSize: '12px', marginTop: '6px', fontStyle: 'italic' }}>
          "{req.note}"
        </div>
      )}
      {!isReadOnly && (
        <>
          {availableSpaces.length > 0 ? (
            <div style={{ marginTop: '10px' }}>
              <label style={{ color: C.faint, fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.6px', fontWeight: 700 }}>Pick a space to assign</label>
              <select value={pickedSpaceId} onChange={e => setPickedSpaceId(e.target.value)} style={{
                width: '100%', background: C.panel2, border: `1px solid ${C.border2}`, borderRadius: '8px',
                padding: '8px 10px', color: C.text, fontSize: '13px', fontFamily: 'inherit', marginTop: '4px',
              }}>
                <option value=''>— Select an available space —</option>
                {availableSpaces.map(s => (
                  <option key={s.id} value={String(s.id)}>{s.label}{s.type ? ` (${s.type})` : ''}</option>
                ))}
              </select>
            </div>
          ) : (
            <div style={{ color: C.faint, fontSize: '12px', marginTop: '10px', fontStyle: 'italic' }}>
              No available spaces at this property. Generate more via the Spaces tab or decline this request.
            </div>
          )}
        </>
      )}
      {(canAssign || canDecline) && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
          {canAssign && (
            <button onClick={() => onAssignSpaceRequest(req.id, parseInt(pickedSpaceId, 10))} style={{
              padding: '7px 12px', background: C.greenSoft, color: C.green,
              border: `1px solid ${C.greenLine}`, borderRadius: '6px',
              cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
            }}>Assign space</button>
          )}
          {canDecline && (
            <button onClick={() => onDeclineSpaceRequest(req.id)} style={{
              padding: '7px 12px', background: C.redSoft, color: C.red,
              border: `1px solid ${C.redLine}`, borderRadius: '6px',
              cursor: 'pointer', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit',
            }}>Decline</button>
          )}
        </div>
      )}
    </div>
  )
}

function GuestsPane({ resident }: { resident: CrmResident }) {
  if (resident.guests.length === 0) {
    return (
      <div style={{ padding: '44px 20px', textAlign: 'center', color: C.faint }}>
        <div style={{ fontSize: '15px', color: C.muted, marginBottom: '5px' }}>No authorized guests</div>
        Guests this resident authorizes will appear here.
      </div>
    )
  }
  return (
    <>
      {resident.guests.map((g, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
          padding: '12px 14px', border: `1px solid ${C.border}`, borderRadius: '10px',
          marginBottom: '10px', background: C.panel2,
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: '13.5px', color: C.text }}>
              {(g as any).guest_name || (g as any).name || '(unnamed)'}
            </div>
            <div style={{ color: C.muted, fontSize: '12px', marginTop: '2px' }}>
              <span style={{ fontFamily: 'Courier New' }}>{(g as any).plate || '—'}</span>
              {(g as any).start_date && (g as any).end_date && (
                <> · {(g as any).start_date} – {(g as any).end_date}</>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

function ActivityPane({ resident }: { resident: CrmResident }) {
  return (
    <div style={{ padding: '20px 0', color: C.faint, fontSize: '13px' }}>
      <div style={{ color: C.muted, marginBottom: '4px' }}>Activity timeline coming in a later slice.</div>
      Will fetch this resident's audit_logs (registration, approvals, plate changes,
      space assign/release, deactivations, edits) — {resident.name}'s recent events.
    </div>
  )
}

function Card({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px', background: C.panel2 }}>
      <div style={{
        fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.6px',
        color: C.faint, margin: '2px 0 10px', fontWeight: 700,
      }}>{title}</div>
      {children}
    </div>
  )
}

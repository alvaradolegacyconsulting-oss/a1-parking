// ════════════════════════════════════════════════════════════════════
// Tow Log — desktop read surface (Commit 6).
//
// Lookup, list, detail, void. The create surface is mobile-only
// (/manager/mobile/tow-log); this is where the record gets read back.
//
// ── BOUNDARY (DECISION_tow_log_is_a_log_sept9_2026) ─────────────────
// The "what would cross the line" list applies HARDER here than on the
// create screen, because a read view is precisely where someone asks
// for a "notify the resident" button or a storage-location field.
//   · No resident- or owner-facing view. No share link.
//   · No fees, charges, or storage location.
//   · No language positioning a record as evidence or compliance.
// `notes` is INTERNAL and labelled as such on screen.
//
// ── SCOPING IS RLS, NOT THIS FILE ───────────────────────────────────
// Managers see their assigned properties, company admins see their
// company — enforced by vehicle_removals RLS. There is deliberately NO
// client-side company or property filter: a second copy of the boundary
// can drift from the first, and worse, it would keep hiding rows if the
// database ever started leaking them, making an RLS regression
// invisible. RLS denials arrive as an empty list with no error, so zero
// rows is reported as "nothing here", never as a failure.
//
// ── NO EDITING IN v1 ────────────────────────────────────────────────
// There is no update RPC and the schema treats a removal as an event
// that happened. A wrong record is VOIDED and a correct one recorded.
// The UI says so where someone would look for an edit button, so the
// absence reads as a decision instead of a gap.
// ════════════════════════════════════════════════════════════════════
'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import { normalizePlate } from '../lib/plate'
import { displayTowReason } from '../lib/tow-reasons'
import { formatTimestamp } from '../lib/format-time'
import { logAudit } from '../lib/audit'
import {
  buildTowLogCsv,
  buildTowLogExportFilename,
  downloadCsv,
  type ExportVariant,
} from '../lib/tow-log-export'
import {
  RANGE_PRESETS,
  DEFAULT_FILTERS,
  filtersAreDefault,
  rangeLabel,
  listRecordedByOptions,
  listOperatorOptions,
  listPropertyOptions,
  REMOVAL_REASONS,
  type RemovalFilters,
  type RangeKey,
  type OperatorOption,
  fetchRemovalsForExport,
  listVehicleRemovals,
  lookupRemovalsByPlate,
  listRemovalMedia,
  signMediaUrls,
  voidVehicleRemoval,
  type VehicleRemoval,
  type RemovalMedia,
} from '../lib/tow-log-writes'

const PAGE_SIZE = 25

const C = {
  panel: '#1e2535',
  border: '#3a4055',
  gold: '#C9A227',
  green: '#4caf50',
  red: '#f44336',
  redDark: '#3a1a1a',
  redBorder: '#b71c1c',
  text: '#e8e8e8',
  muted: '#888',
  faint: '#666',
}

export default function TowLogTab() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [rows, setRows] = useState<VehicleRemoval[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)

  // ── Filter state lives in the URL, not in component state ─────────
  // Three things fall out of that: back from a detail returns to the
  // same filtered list; the view is shareable ("every handicap tow this
  // year" is a link a PM can send an owner); and a refresh on a flaky
  // connection doesn't lose it.
  const filters = useMemo<RemovalFilters>(() => {
    const rangeParam = searchParams.get('range')
    const range = (RANGE_PRESETS.some(r => r.key === rangeParam) ? rangeParam : DEFAULT_FILTERS.range) as RangeKey
    const operatorParam = searchParams.get('operator')
    return {
      range,
      recordedBy: searchParams.get('by') || null,
      reasonCode: searchParams.get('reason') || null,
      operatorId: operatorParam === 'none' ? 'none'
                : operatorParam && /^\d+$/.test(operatorParam) ? Number(operatorParam)
                : null,
      property: searchParams.get('property') || null,
      // Default ON. Only an explicit voided=0 turns it off, so a clean
      // URL means a clean state.
      includeVoided: searchParams.get('voided') !== '0',
    }
  }, [searchParams])

  // Option lists — built from rows the caller can see (see the write
  // layer), so a dropdown never offers someone with nothing to show.
  const [recordedByOptions, setRecordedByOptions] = useState<string[]>([])
  const [operatorOptions, setOperatorOptions] = useState<OperatorOption[]>([])
  const [propertyOptions, setPropertyOptions] = useState<string[]>([])
  const [role, setRole] = useState<string>('')
  // "Has this property ever recorded anything" — distinguishes the
  // feature-is-new empty state from the nothing-in-this-window one.
  const [everCount, setEverCount] = useState<number | null>(null)

  // Writes the filter into the URL. Preserves params this component
  // doesn't own, omits its own at their defaults so a clean URL means a
  // clean state, and uses REPLACE rather than push — changing a filter
  // should not stack history entries someone has to tap back through.
  const applyFilters = useCallback((next: RemovalFilters) => {
    const params = new URLSearchParams(searchParams.toString())
    const set = (key: string, value: string | null) => {
      if (value === null) params.delete(key); else params.set(key, value)
    }
    set('range',    next.range === DEFAULT_FILTERS.range ? null : next.range)
    set('by',       next.recordedBy)
    set('reason',   next.reasonCode)
    set('operator', next.operatorId === null ? null : String(next.operatorId))
    set('property', next.property)
    set('voided',   next.includeVoided ? null : '0')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    setPage(0)
  }, [router, pathname, searchParams])

  const patch = (delta: Partial<RemovalFilters>) => applyFilters({ ...filters, ...delta })

  // Lookup
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<VehicleRemoval[] | null>(null)
  const [searchedPlate, setSearchedPlate] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)

  // Detail
  const [selected, setSelected] = useState<VehicleRemoval | null>(null)
  const [media, setMedia] = useState<RemovalMedia[]>([])
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [mediaLoading, setMediaLoading] = useState(false)

  // Export
  const [exportBusy, setExportBusy] = useState<ExportVariant | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  // Void
  const [voidReason, setVoidReason] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    const result = await listVehicleRemovals(supabase, { page, pageSize: PAGE_SIZE, filters })
    setRows(result.rows)
    setTotal(result.total)
    setLoading(false)
  }, [page, filters])

  useEffect(() => { refetch() }, [refetch])

  // Option lists + role + the ever-count. Loaded once — they change only
  // when a removal is recorded, and this surface doesn't record any.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [by, ops, props, roleResult, ever] = await Promise.all([
        listRecordedByOptions(supabase),
        listOperatorOptions(supabase),
        listPropertyOptions(supabase),
        supabase.rpc('get_my_role'),
        listVehicleRemovals(supabase, {
          page: 0, pageSize: 1,
          filters: { ...DEFAULT_FILTERS, range: 'all', includeVoided: true },
        }),
      ])
      if (cancelled) return
      setRecordedByOptions(by)
      setOperatorOptions(ops)
      setPropertyOptions(props)
      setRole(String(roleResult.data ?? ''))
      setEverCount(ever.total)
    })()
    return () => { cancelled = true }
  }, [])

  // ── Lookup ────────────────────────────────────────────────────────
  // The Monday-morning question: "was my car towed?" It sits above the
  // list because it is the reason this surface exists, not a filter.
  async function runSearch() {
    const normalized = normalizePlate(search)
    if (!normalized) { setSearchResults(null); setSearchedPlate(''); return }
    setSearchBusy(true)
    const results = await lookupRemovalsByPlate(supabase, normalized)
    setSearchedPlate(normalized)
    setSearchResults(results)
    setSearchBusy(false)
    if (results.length === 1) openDetail(results[0])
  }

  function clearSearch() {
    setSearch(''); setSearchResults(null); setSearchedPlate('')
  }

  // ── Detail ────────────────────────────────────────────────────────
  async function openDetail(r: VehicleRemoval) {
    setSelected(r); setVoidReason(''); setVoidError(null)
    setMedia([]); setMediaUrls({})
    setMediaLoading(true)
    const rows = await listRemovalMedia(supabase, r.id)
    setMedia(rows)
    // Signed URLs are short-lived bearer links minted by
    // /api/tow-log/media-url as the caller. Fetched on open, not with
    // the list — a list of 25 rows would mint links nobody looks at.
    if (rows.length > 0) setMediaUrls(await signMediaUrls(rows.map(m => m.storage_path)))
    setMediaLoading(false)
  }

  // ── Export ────────────────────────────────────────────────────────
  // Exports THE CURRENT FILTERED SET, exactly. What is on screen is what
  // is in the file — same range, same operator, same reason, same voided
  // toggle. A complete export is the All range with filters cleared, not
  // a separate button that could disagree with the screen it came from.
  async function handleExport(variant: ExportVariant) {
    setExportError(null)
    setExportBusy(variant)
    const result = await fetchRemovalsForExport(supabase, filters)
    setExportBusy(null)

    // 🔴 Refuse rather than write a partial file. A silently truncated
    // export is a wrong answer that looks complete, and the reader has
    // no way to tell.
    if (!result.ok) {
      setExportError(
        result.reason === 'too_many'
          ? `${result.total.toLocaleString()} records match these filters — more than the ${result.limit.toLocaleString()} an export can produce in one file. Narrow the date range and export again.`
          : 'The export could not be built. Nothing was downloaded — try again.',
      )
      return
    }
    if (result.rows.length === 0) {
      setExportError('Nothing to export with these filters.')
      return
    }

    const propertyLabel = filters.property
      ?? (propertyOptions.length === 1 ? propertyOptions[0] : 'all-properties')
    const filename = buildTowLogExportFilename(propertyLabel, filters, variant)
    downloadCsv(filename, buildTowLogCsv(result.rows, variant))

    // On a log of record, "who pulled a copy of this and when" is asked
    // once and cannot be answered retroactively. Cheap now, impossible
    // to backfill. Non-blocking: the file is already downloaded, and a
    // failed audit write must not look like a failed export.
    logAudit({
      action: 'TOW_LOG_EXPORTED',
      table_name: 'vehicle_removals',
      new_values: {
        variant,
        row_count: result.rows.length,
        filename,
        filters: {
          range: filters.range,
          recorded_by: filters.recordedBy,
          reason_code: filters.reasonCode,
          tow_operator_id: filters.operatorId,
          property: filters.property,
          include_voided: filters.includeVoided,
        },
      },
    }).catch(e => console.error('[tow-log] export audit failed', e))
  }

  // ── Void ──────────────────────────────────────────────────────────
  async function handleVoid() {
    if (!selected) return
    setVoidError(null)
    if (!voidReason.trim()) { setVoidError('Enter why this record is being voided.'); return }

    // Confirm names WHAT is being voided. Voiding the wrong row on a log
    // of record is a bad afternoon, and there is no un-void.
    const ok = window.confirm(
      `Void this removal record?\n\n` +
      `Plate: ${selected.plate}\n` +
      `Towed: ${formatTimestamp(selected.towed_at)}\n` +
      `Operator: ${selected.operator_name}\n\n` +
      `This cannot be undone. The record stays in the log, marked as voided. ` +
      `To correct it, record a new removal.`,
    )
    if (!ok) return

    setVoidBusy(true)
    const result = await voidVehicleRemoval(supabase, { removalId: selected.id, reason: voidReason })
    setVoidBusy(false)
    if (!result.ok) { setVoidError(result.message); return }
    setSelected(result.removal)
    setVoidReason('')
    await refetch()
    if (searchedPlate) setSearchResults(await lookupRemovalsByPlate(supabase, searchedPlate))
  }

  const listRows = searchResults ?? rows
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      {/* ── Lookup ─────────────────────────────────────────────── */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <label style={label()}>Was this vehicle towed?</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={e => setSearch(normalizePlate(e.target.value))}
            onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
            placeholder="Plate"
            style={{ ...input(), flex: '1 1 200px', fontFamily: 'Courier New, monospace', letterSpacing: '0.08em', fontWeight: 'bold' }}
          />
          <button onClick={runSearch} disabled={searchBusy} style={btn(true)}>
            {searchBusy ? 'Searching…' : 'Search'}
          </button>
          {searchResults !== null && <button onClick={clearSearch} style={btn(false)}>Clear</button>}
        </div>

        {/* 🔴 Load-bearing sentence. Search deliberately ignores every
            filter. Without saying so, the first person who searches a
            plate they KNOW exists and gets nothing reads it as a bug —
            and stops trusting the screen for the exact question it
            exists to answer. */}
        <div style={{ color: C.faint, fontSize: '11px', marginTop: '6px' }}>
          Searches every record, ignoring the filters below.
        </div>

        {searchResults !== null && searchResults.length === 0 && (
          // A clean "no" is a useful answer to hand a resident, so say it
          // plainly rather than showing an empty table.
          <div style={{ color: C.text, fontSize: '13px', marginTop: '10px', lineHeight: 1.6 }}>
            No removal has been recorded for <strong style={{ fontFamily: 'Courier New, monospace' }}>{searchedPlate}</strong> at
            {' '}the properties you can see. Nothing in this log says that vehicle was towed.
          </div>
        )}
        {searchResults !== null && searchResults.length > 0 && (
          <div style={{ color: C.muted, fontSize: '12px', marginTop: '10px' }}>
            {searchResults.length} record{searchResults.length === 1 ? '' : 's'} for {searchedPlate}
          </div>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────── */}
      {/* Stacked, not a row. The manager portal is not phone-tuned (Fix
          B filed, unshipped) and a horizontal filter bar is the first
          thing to wrap badly at 390px. Presets wrap; the selects go full
          width. Not a responsive pass — just not making it worse. */}
      {searchResults === null && (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
            {RANGE_PRESETS.map(preset => (
              <button
                key={preset.key}
                onClick={() => patch({ range: preset.key })}
                style={{
                  background: filters.range === preset.key ? C.gold : 'transparent',
                  color: filters.range === preset.key ? '#0f1117' : C.muted,
                  border: `1px solid ${filters.range === preset.key ? C.gold : C.border}`,
                  borderRadius: '6px', padding: '6px 10px', fontSize: '12px',
                  fontWeight: 'bold', cursor: 'pointer',
                }}
              >{preset.label}</button>
            ))}
          </div>

          <select value={filters.recordedBy ?? ''} onChange={e => patch({ recordedBy: e.target.value || null })} style={input()}>
            <option value="">Logged by — anyone</option>
            {recordedByOptions.map(email => <option key={email} value={email}>{email}</option>)}
          </select>

          <select value={filters.reasonCode ?? ''} onChange={e => patch({ reasonCode: e.target.value || null })} style={input()}>
            <option value="">Reason — any</option>
            {/* Same order as the create picker, so the two agree. */}
            {REMOVAL_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>

          {/* Value is tow_operator_id; the label is the operator's name
              NOW. A row in the results may display a DIFFERENT name —
              its snapshot from when the tow happened. That is correct.
              See the query-site note in tow-log-writes.ts. */}
          {operatorOptions.length > 0 && (
            <select
              value={filters.operatorId === null ? '' : String(filters.operatorId)}
              onChange={e => patch({
                operatorId: e.target.value === '' ? null
                          : e.target.value === 'none' ? 'none'
                          : Number(e.target.value),
              })}
              style={input()}
            >
              <option value="">Operator — any</option>
              {operatorOptions.map(o => <option key={String(o.id)} value={String(o.id)}>{o.label}</option>)}
            </select>
          )}

          {/* Company admins only, and only with more than one property in
              the log. A manager at a single property doesn't need a
              control that can only take one value. */}
          {role === 'company_admin' && propertyOptions.length > 1 && (
            <select value={filters.property ?? ''} onChange={e => patch({ property: e.target.value || null })} style={input()}>
              <option value="">Property — all</option>
              {propertyOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
            <label style={{ color: C.muted, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={filters.includeVoided} onChange={e => patch({ includeVoided: e.target.checked })} />
              Show voided records
            </label>
            {!filtersAreDefault(filters) && (
              <button onClick={() => applyFilters(DEFAULT_FILTERS)} style={{ background: 'none', border: 'none', color: C.gold, fontSize: '12px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      {/* Count NAMES THE WINDOW. "4 removals" implies four total; "4
          removals in September" is a filtered fact. */}
      {searchResults === null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <div style={{ color: C.muted, fontSize: '12px' }}>
            {loading ? 'Loading…' : `${total} removal${total === 1 ? '' : 's'} ${rangeLabel(filters.range)}`}
          </div>
          {total > 0 && (
            // 🔴 TWO BUTTONS, LABELLED AT THE POINT OF CLICKING. Not one
            // export with a checkbox — the difference between these two
            // files is "did a vendor just receive a manager's internal
            // note about a resident", and that is not a default anyone
            // should be able to leave wrong.
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => handleExport('shareable')} disabled={exportBusy !== null} style={exportBtn()}>
                {exportBusy === 'shareable' ? 'Building…' : '↓ Export (share with operator)'}
              </button>
              <button onClick={() => handleExport('full')} disabled={exportBusy !== null} style={exportBtn()}>
                {exportBusy === 'full' ? 'Building…' : '↓ Export (internal — includes notes)'}
              </button>
            </div>
          )}
        </div>
      )}

      {exportError && (
        <div style={{ background: C.redDark, border: `1px solid ${C.redBorder}`, borderRadius: '8px', padding: '10px', color: C.text, fontSize: '13px', lineHeight: 1.6, marginBottom: '10px' }}>
          {exportError}
        </div>
      )}

      {/* ── List ───────────────────────────────────────────────── */}
      {/* Three distinct causes, three distinct messages. An empty table
          with no explanation is where someone concludes the screen is
          broken. */}
      {listRows.length === 0 && !loading && searchResults === null && (
        <div style={{ color: C.muted, fontSize: '13px', padding: '20px', textAlign: 'center', lineHeight: 1.7 }}>
          {everCount === 0 ? (
            <>
              No vehicle removals have been recorded yet.
              <br />
              <span style={{ color: C.faint }}>Removals are logged from a phone at <strong>/manager/mobile/tow-log</strong>.</span>
            </>
          ) : filtersAreDefault(filters) ? (
            <>
              Nothing {rangeLabel(filters.range)}.
              <br />
              <button onClick={() => patch({ range: 'last_90' })} style={linkBtn()}>Try Last 90 days</button>
              {' or '}
              <button onClick={() => patch({ range: 'all' })} style={linkBtn()}>All</button>.
            </>
          ) : (
            <>
              No removals match these filters.
              <br />
              <button onClick={() => applyFilters(DEFAULT_FILTERS)} style={linkBtn()}>Clear filters</button>
            </>
          )}
        </div>
      )}

      {listRows.map(r => {
        const voided = !!r.voided_at
        return (
          <div
            key={r.id}
            onClick={() => openDetail(r)}
            style={{
              background: C.panel,
              border: `1px solid ${selected?.id === r.id ? C.gold : C.border}`,
              borderRadius: '8px', padding: '10px 12px', marginBottom: '8px',
              cursor: 'pointer', opacity: voided ? 0.6 : 1,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'Courier New, monospace', fontWeight: 'bold', fontSize: '15px',
                letterSpacing: '0.08em', color: C.text,
                // Voided rows stay visible and legible — struck through,
                // dimmed, badged. Hiding one is how a log stops being a log.
                textDecoration: voided ? 'line-through' : 'none',
              }}>{r.plate}</span>
              {voided && (
                <span style={{ background: C.redDark, border: `1px solid ${C.redBorder}`, color: C.red, fontSize: '10px', padding: '2px 6px', borderRadius: '4px', letterSpacing: '0.06em' }}>
                  VOIDED
                </span>
              )}
              <span style={{ color: C.muted, fontSize: '12px', marginLeft: 'auto' }}>{formatTimestamp(r.towed_at)}</span>
            </div>
            {/* Stacked, not a grid — the manager portal is not phone-tuned
                (Fix B filed, unshipped) and a tight column set is the
                first thing that breaks at 390px. */}
            <div style={{ color: C.muted, fontSize: '12px', marginTop: '4px', lineHeight: 1.6 }}>
              {displayTowReason(r.reason_code)} · {r.operator_name}
              {r.removal_type !== 'tow' && <> · <span style={{ color: C.gold }}>{r.removal_type}</span></>}
              <br />
              <span style={{ color: C.faint }}>Authorized by {r.authorized_by_name || r.authorized_by_email} · {r.property}</span>
            </div>
          </div>
        )
      })}

      {/* ── Pagination ─────────────────────────────────────────── */}
      {searchResults === null && total > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', marginTop: '12px' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={btn(page > 0)}>‹ Prev</button>
          <span style={{ color: C.muted, fontSize: '12px' }}>Page {page + 1} of {pageCount}</span>
          <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} style={btn(page < pageCount - 1)}>Next ›</button>
        </div>
      )}

      {/* ── Detail ─────────────────────────────────────────────── */}
      {selected && (
        <div style={{ background: C.panel, border: `1px solid ${C.gold}`, borderRadius: '10px', padding: '16px', marginTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
            <div style={{ fontFamily: 'Courier New, monospace', fontSize: '20px', fontWeight: 'bold', letterSpacing: '0.1em', color: C.gold }}>
              {selected.plate}{selected.plate_state ? ` · ${selected.plate_state}` : ''}
            </div>
            <button onClick={() => setSelected(null)} style={{ ...btn(false), marginLeft: 'auto' }}>Close</button>
          </div>

          {selected.voided_at && (
            <div style={{ background: C.redDark, border: `1px solid ${C.redBorder}`, borderRadius: '8px', padding: '10px', marginBottom: '12px', fontSize: '13px', lineHeight: 1.6 }}>
              <strong style={{ color: C.red }}>VOIDED</strong> {formatTimestamp(selected.voided_at)} by {selected.voided_by_email}
              <br />
              <span style={{ color: C.muted }}>Reason: {selected.void_reason}</span>
            </div>
          )}

          {/* 🔴 towed_at and created_at BOTH shown, labelled distinctly.
              On a backdated entry they differ by days, and that
              difference is the point: the physical event and the
              record-entry are separate facts. */}
          <Row label="Towed">{formatTimestamp(selected.towed_at)}</Row>
          <Row label="Recorded">{formatTimestamp(selected.created_at)} by {selected.recorded_by_email}</Row>
          <Row label="Property">{selected.property}</Row>
          <Row label="Type">{selected.removal_type}</Row>
          {/* Vehicle description. Commit 6 was built before these columns
              could be populated, so nothing displayed them — and once the
              2026-09-12 linked-vehicle fill landed, make and model
              appeared in the CSV export and NOWHERE ON SCREEN. The
              manager answering "where is my car" saw less than the file
              they would send the operator.
              Omitted entirely when all four are null rather than
              rendering an empty label: a walk-in with no description is
              a normal record, not a gap.
              No year — vehicle_removals has no year column, only these
              four. */}
          {(selected.make || selected.model || selected.color || selected.plate_state) && (
            <Row label="Vehicle">
              {[
                [selected.make, selected.model].filter(Boolean).join(' ') || null,
                selected.color,
                selected.plate_state,
              ].filter(Boolean).join(' · ')}
            </Row>
          )}
          <Row label="Reason">{displayTowReason(selected.reason_code)}</Row>
          {selected.reason_notes && (
            <Row label="Why (on the record)">{selected.reason_notes}</Row>
          )}
          <Row label="Removed by">
            {selected.operator_name}{selected.operator_phone ? ` · ${selected.operator_phone}` : ''}
          </Row>
          <Row label="Authorized by">
            {selected.authorized_by_name ? `${selected.authorized_by_name} · ` : ''}{selected.authorized_by_email}
          </Row>


          {selected.notes && (
            <div style={{ marginTop: '12px', background: '#0f1117', border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px' }}>
              <div style={{ ...label(), color: C.gold }}>Internal notes — your team only</div>
              <div style={{ color: C.text, fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{selected.notes}</div>
            </div>
          )}

          {/* ── Media ────────────────────────────────────────── */}
          <div style={{ marginTop: '14px' }}>
            <div style={label()}>Photos &amp; attachments</div>
            {mediaLoading && <div style={{ color: C.muted, fontSize: '12px' }}>Loading…</div>}
            {!mediaLoading && media.length === 0 && <div style={{ color: C.faint, fontSize: '12px' }}>None attached.</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {media.map(m => {
                const url = mediaUrls[m.storage_path]
                if (!url) {
                  // A missing URL means the signing route refused it —
                  // out of scope, or the object is gone. Say that,
                  // rather than rendering a broken image.
                  return (
                    <div key={m.id} style={{ border: `1px dashed ${C.border}`, borderRadius: '6px', padding: '10px', color: C.faint, fontSize: '11px', maxWidth: '160px' }}>
                      {m.kind} · could not be displayed
                    </div>
                  )
                }
                if (m.kind === 'photo') {
                  return (
                    <a key={m.id} href={url} target="_blank" rel="noopener noreferrer">
                      <img src={url} alt={`${m.kind} attachment`} style={{ width: '120px', height: '120px', objectFit: 'cover', borderRadius: '6px', border: `1px solid ${C.border}` }} />
                    </a>
                  )
                }
                return (
                  <a key={m.id} href={url} target="_blank" rel="noopener noreferrer"
                     style={{ color: C.gold, fontSize: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px' }}>
                    {m.kind} ↗
                  </a>
                )
              })}
            </div>
            {media.length > 0 && (
              <div style={{ color: C.faint, fontSize: '11px', marginTop: '6px' }}>
                Links expire after a few minutes. Reopen this record to view them again.
              </div>
            )}
          </div>

          {/* ── Void / no-edit ───────────────────────────────── */}
          {!selected.voided_at && (
            <div style={{ marginTop: '16px', borderTop: `1px solid ${C.border}`, paddingTop: '14px' }}>
              {/* Where someone looks for an Edit button. The absence is
                  a decision, so it is stated rather than left blank. */}
              <div style={{ color: C.muted, fontSize: '12px', lineHeight: 1.6, marginBottom: '10px' }}>
                Removal records cannot be edited — each one is a record of something that happened.
                If this one is wrong, void it with the reason and record a corrected removal.
              </div>
              <input
                value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                placeholder="Reason for voiding (required)"
                style={input()}
              />
              {voidError && (
                <div style={{ background: C.redDark, border: `1px solid ${C.redBorder}`, borderRadius: '6px', padding: '8px', color: C.text, fontSize: '12px', marginBottom: '8px' }}>
                  {voidError}
                </div>
              )}
              <button onClick={handleVoid} disabled={voidBusy} style={{ ...btn(true), background: C.redDark, borderColor: C.redBorder, color: C.red }}>
                {voidBusy ? 'Voiding…' : 'Void this record'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '10px', padding: '4px 0', fontSize: '13px', flexWrap: 'wrap' }}>
      <span style={{ color: C.muted, minWidth: '150px', flex: '0 0 auto' }}>{label}</span>
      <span style={{ color: C.text, flex: '1 1 200px' }}>{children}</span>
    </div>
  )
}

function exportBtn(): React.CSSProperties {
  return {
    background: 'transparent', color: C.gold,
    border: `1px solid ${C.border}`, borderRadius: '6px',
    padding: '6px 10px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer',
  }
}

function linkBtn(): React.CSSProperties {
  return { background: 'none', border: 'none', color: C.gold, fontSize: '13px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }
}

function label(): React.CSSProperties {
  return { display: 'block', color: C.muted, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }
}

function input(): React.CSSProperties {
  return {
    display: 'block', width: '100%', boxSizing: 'border-box',
    padding: '10px', marginBottom: '8px',
    background: '#0f1117', color: C.text,
    border: `1px solid ${C.border}`, borderRadius: '8px', fontSize: '14px',
  }
}

function btn(enabled: boolean): React.CSSProperties {
  return {
    background: enabled ? C.panel : 'transparent',
    color: enabled ? C.gold : C.faint,
    border: `1px solid ${enabled ? C.gold : C.border}`,
    borderRadius: '8px', padding: '10px 14px',
    fontSize: '13px', fontWeight: 'bold',
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}

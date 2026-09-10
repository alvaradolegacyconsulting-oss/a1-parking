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

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { normalizePlate } from '../lib/plate'
import { displayTowReason } from '../lib/tow-reasons'
import { formatTimestamp } from '../lib/format-time'
import {
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
  const [rows, setRows] = useState<VehicleRemoval[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [includeVoided, setIncludeVoided] = useState(true)   // shown by default — it is a log
  const [loading, setLoading] = useState(false)

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

  // Void
  const [voidReason, setVoidReason] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    const result = await listVehicleRemovals(supabase, { page, pageSize: PAGE_SIZE, includeVoided })
    setRows(result.rows)
    setTotal(result.total)
    setLoading(false)
  }, [page, includeVoided])

  useEffect(() => { refetch() }, [refetch])

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

      {/* ── List controls ──────────────────────────────────────── */}
      {searchResults === null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ color: C.muted, fontSize: '12px' }}>
            {loading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
          </div>
          <label style={{ color: C.muted, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={includeVoided} onChange={e => { setIncludeVoided(e.target.checked); setPage(0) }} />
            Show voided records
          </label>
        </div>
      )}

      {/* ── List ───────────────────────────────────────────────── */}
      {listRows.length === 0 && !loading && searchResults === null && (
        <div style={{ color: C.muted, fontSize: '13px', padding: '20px', textAlign: 'center' }}>
          No removals recorded yet.
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
          {(selected.make || selected.model || selected.color) && (
            <Row label="Vehicle">{[selected.color, selected.make, selected.model].filter(Boolean).join(' ')}</Row>
          )}

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

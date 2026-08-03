'use client'
// AP-MANAGE-CLIENT + AP-UI-REFINE (2026-07-23 + 2026-07-24): shared
// per-property manager for authorized_plates.
//
// Modes via props:
//   readOnly:    hide add form, Remove buttons, modal (CA surface)
//   collapsible: wrap in disclosure header, collapsed by default (CA)
//
// Writes to `authorized_plates` ONLY. Grep-checkable: this file's
// `.from('...')` calls must all reference authorized_plates.
//
// added_by / removed_by / removed_at stamped server-side by the trigger.
// Client sends '' for added_by (empty triggers fail-loud guard; a
// non-empty placeholder would satisfy the check and land in audit
// verbatim).
//
// onCountChange contract: fires after every refetchList with the current
// list length (single owner of the count — consumer stores it as-is,
// no parallel head:true fetch needed).
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../supabase'
import AuthorizedPlateRemoveConfirmModal from './AuthorizedPlateRemoveConfirmModal'
import { formatDate } from '../lib/format-time'

type Category = 'staff' | 'vendor' | 'other'
type CategoryFilter = 'all' | Category

interface AuthorizedPlate {
  id: number
  plate: string
  label: string | null
  category: Category
  added_by: string
  added_at: string
}

interface Props {
  propertyId: number
  propertyName: string
  onCountChange?: (count: number) => void
  readOnly?: boolean       // CA surface — hide add + remove + modal
  collapsible?: boolean    // CA surface — collapsed by default
}

const CATEGORY_LABEL: Record<Category, string> = {
  staff:  'Staff',
  vendor: 'Vendor',
  other:  'Other',
}
// Palette says "kind of thing," not "level of concern." Amber is reserved
// for caution (plate_under_review, visitor pass, DNT); vendor uses teal
// so the badge reads as a category not a warning.
const CATEGORY_BADGE_COLOR: Record<Category, { bg: string; fg: string; border: string }> = {
  staff:  { bg: '#1e2535', fg: '#7ab1ff', border: '#3b82f6' },  // blue
  vendor: { bg: '#0a2a26', fg: '#5eead4', border: '#14b8a6' },  // teal (not amber — amber = caution palette)
  other:  { bg: '#1e1e2e', fg: '#aaa',    border: '#555' },     // grey
}
// Fallback for unknown category (CHECK constraint is designed to be
// extended one line at a time — if a value lands in the table before
// this map is updated, unknown values render legibly rather than
// throwing on `badge.bg` access. Same discipline as the driver render
// unknown-status fallback.)
const BADGE_FALLBACK = CATEGORY_BADGE_COLOR.other

export default function AuthorizedPlatesManager({
  propertyId, propertyName, onCountChange,
  readOnly = false, collapsible = false,
}: Props) {
  const [list, setList] = useState<AuthorizedPlate[]>([])
  const [plateInput, setPlateInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [categoryInput, setCategoryInput] = useState<Category>('staff')
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [targetRemove, setTargetRemove] = useState<AuthorizedPlate | null>(null)
  const [loading, setLoading] = useState(true)
  // Collapsible: collapsed by default when collapsible=true; always expanded otherwise.
  const [expanded, setExpanded] = useState(!collapsible)
  // Toolbar state
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')

  const refetchList = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('authorized_plates')
      .select('id, plate, label, category, added_by, added_at')
      .eq('property_id', propertyId)
      .is('removed_at', null)
      .order('plate', { ascending: true })   // AP-UI-REFINE: sort by plate, not added_at DESC
    const rows = (data as AuthorizedPlate[]) ?? []
    setList(rows)
    setLoading(false)
    // Single owner of count — consumer stores as-is, no parallel head:true fetch.
    onCountChange?.(rows.length)
  }, [propertyId, onCountChange])

  useEffect(() => { refetchList() }, [refetchList])

  // Reset UI state when propertyId changes — search / filter / messages
  // are all component-scoped; propertyId is a prop. Without this, a CA
  // who searches "HVAC" then switches property sees "No plates match"
  // on a property that has plates.
  useEffect(() => {
    setSearch('')
    setCategoryFilter('all')
    setError(null)
    setSuccessMsg(null)
  }, [propertyId])

  // Client-side filter: category + search (matches plate OR label).
  const filteredList = useMemo(() => {
    const q = search.trim().toUpperCase()
    return list.filter(row => {
      if (categoryFilter !== 'all' && row.category !== categoryFilter) return false
      if (!q) return true
      const plateMatch = row.plate.toUpperCase().includes(q)
      const labelMatch = (row.label ?? '').toUpperCase().includes(q)
      return plateMatch || labelMatch
    })
  }, [list, search, categoryFilter])

  async function handleAdd() {
    setError(null); setSuccessMsg(null)
    const normalized = plateInput.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!normalized) { setError('Plate is required.'); return }

    setSubmitting(true)
    const { error: insErr } = await supabase.from('authorized_plates').insert({
      property_id: propertyId,
      plate: normalized,
      label: labelInput.trim() || null,
      category: categoryInput,
      added_by: '', // empty triggers fail-loud guard if JWT unresolvable; server override wins
    })
    setSubmitting(false)

    if (insErr) {
      if (insErr.code === '23505') {
        setError(`${normalized} is already authorized at ${propertyName}.`)
        return
      }
      // Friendly to the user, raw to the console — same shape as handleRemove.
      console.error('[authorized-plates] add failed', insErr)
      setError('Add failed — the server rejected the change. Refresh and try again; if it persists, contact support.')
      return
    }

    setPlateInput(''); setLabelInput(''); setCategoryInput('staff')
    setSuccessMsg(`Added ${normalized} (${CATEGORY_LABEL[categoryInput]}) to ${propertyName}.`)
    setTimeout(() => setSuccessMsg(null), 5000)
    await refetchList()
  }

  async function handleRemove(id: number) {
    setError(null); setSuccessMsg(null)
    const { data, error: upErr } = await supabase
      .from('authorized_plates')
      .update({ removed_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')

    if (upErr) {
      // Friendly to the user, raw to the console.
      console.error('[authorized-plates] remove failed', upErr)
      setError('Remove failed — the server rejected the change. Refresh and try again; if it persists, contact support.')
      return
    }
    if (!data || data.length === 0) {
      setError('Remove failed — no rows updated. You may not have permission for this property.')
      return
    }
    await refetchList()
  }

  // Collapsed disclosure header (CA surface, collapsed state)
  if (collapsible && !expanded) {
    return (
      <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px' }}>
        <button onClick={() => setExpanded(true)}
          style={{ width:'100%', textAlign:'left', padding:'12px 16px', background:'transparent', border:'none', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ color:'white', fontWeight:'bold', fontSize:'13px' }}>
            Authorized Plates <span style={{ color:'#aaa', fontWeight:'normal' }}>({loading ? '…' : list.length})</span>
          </span>
          <span style={{ color:'#aaa', fontSize:'12px' }}>▸</span>
        </button>
      </div>
    )
  }

  return (
    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
      {/* Header — with collapse toggle when collapsible */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'4px' }}>
        <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>
          Authorized Plates <span style={{ color:'#aaa', fontWeight:'normal' }}>({list.length})</span>
        </p>
        {collapsible && (
          <button onClick={() => setExpanded(false)}
            style={{ background:'transparent', border:'none', color:'#aaa', fontSize:'12px', cursor:'pointer', padding:'4px 8px' }}>▾ Collapse</button>
        )}
      </div>
      {/* Boundary carried in the sub-copy (Mateo 2026-07-23): CA surface
          has no Visitor Pass Quota Exemptions section to contrast against,
          so this header text is the only thing distinguishing standing
          authorization from tow protection. Do not trim as verbose. */}
      <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>
        Staff, vendors, or contractors who regularly park at {propertyName}. These plates show as <strong style={{ color:'#4caf50' }}>Authorized</strong> when scanned — <strong>and can still be cited for violations</strong> like blocking a fire lane or occupying a reserved space.
      </p>

      {/* Toolbar: search + category filter. Hidden when list empty. */}
      {!loading && list.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', gap:'8px', marginBottom:'12px' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search plate or label…"
            style={{ padding:'7px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'12px', outline:'none', boxSizing:'border-box' as const }}
          />
          <div style={{ display:'flex', gap:'4px', background:'#0f1117', borderRadius:'6px', padding:'3px' }}>
            {(['all','staff','vendor','other'] as CategoryFilter[]).map(f => (
              <button key={f} onClick={() => setCategoryFilter(f)}
                style={{ flex:1, padding:'6px', border:'none', borderRadius:'4px', cursor:'pointer', fontSize:'11px', fontWeight:'bold',
                         background: categoryFilter === f ? '#C9A227' : 'transparent',
                         color:      categoryFilter === f ? '#0f1117' : '#888',
                         fontFamily:'Arial' }}>
                {f === 'all' ? 'All' : CATEGORY_LABEL[f as Category]}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px' }}>Loading…</p>
      ) : list.length === 0 ? (
        <div style={{ padding:'20px', textAlign:'center', color:'#888', border:'1px dashed #333', borderRadius:'8px', marginBottom:'14px' }}>
          <p style={{ fontSize:'14px', fontWeight:'bold', color:'#aaa', margin:'0 0 8px' }}>No authorized vehicles yet.</p>
          <p style={{ fontSize:'13px', margin:'0', lineHeight:'1.6' }}>
            Add staff, vendors, or contractors who park here regularly. Their plates will show as <strong style={{ color:'#4caf50' }}>Authorized</strong> when scanned — <strong>and can still be cited for violations</strong> like blocking a fire lane or occupying a reserved space.
          </p>
        </div>
      ) : filteredList.length === 0 ? (
        <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', textAlign:'center', padding:'20px' }}>
          No plates match the current filter.
        </p>
      ) : (
        <div style={{ marginBottom:'14px' }}>
          {filteredList.map(row => {
            // Fallback for unknown category — renders legibly instead of
            // throwing on badge.bg access. Same discipline as the driver
            // render's unknown-status fallback.
            const badge     = CATEGORY_BADGE_COLOR[row.category] ?? BADGE_FALLBACK
            const badgeText = CATEGORY_LABEL[row.category] ?? row.category
            return (
              <div key={row.id} style={{ padding:'10px 12px', background:'#1e2535', borderRadius:'6px', marginBottom:'6px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'8px' }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap' }}>
                      <span style={{ color:'white', fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold', letterSpacing:'0.08em' }}>{row.plate}</span>
                      <span style={{ background:badge.bg, color:badge.fg, border:`1px solid ${badge.border}`, padding:'1px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                        {badgeText}
                      </span>
                    </div>
                    {row.label && (
                      <div style={{ color:'#aaa', fontSize:'12px', fontStyle:'italic', marginTop:'3px', wordBreak:'break-word' }}>{row.label}</div>
                    )}
                    <div style={{ color:'#555', fontSize:'10px', marginTop:'4px' }}>Added by {row.added_by} · {formatDate(row.added_at)}</div>
                  </div>
                  {!readOnly && (
                    <button onClick={() => setTargetRemove(row)}
                      style={{ padding:'3px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'5px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', flexShrink:0 }}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add form — hidden on readOnly (CA surface) */}
      {!readOnly && (
        <div style={{ display:'flex', flexDirection:'column', gap:'8px', paddingTop:'12px', borderTop:'1px solid #2a2f3d' }}>
          <input
            value={plateInput}
            onChange={e => setPlateInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onKeyDown={e => e.key === 'Enter' && !submitting && handleAdd()}
            placeholder="ABC1234"
            maxLength={10}
            style={{ padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', fontFamily:'Courier New', fontWeight:'bold', outline:'none', boxSizing:'border-box' as const }}
          />
          <textarea
            value={labelInput}
            onChange={e => setLabelInput(e.target.value)}
            maxLength={80}
            placeholder={`For your reference only. e.g. "Maintenance staff", "Acme HVAC".\nNot shown to drivers. 80 characters max.`}
            rows={2}
            style={{ padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'12px', fontFamily:'Arial', outline:'none', boxSizing:'border-box' as const, resize:'vertical' as const }}
          />
          {/* Category segmented control — defaults to Staff (common case).
              No editing after add per plate-immutability convention;
              wrong category → remove + re-add. */}
          <div style={{ display:'flex', gap:'4px', background:'#0f1117', borderRadius:'6px', padding:'3px' }}>
            {(['staff','vendor','other'] as Category[]).map(cat => (
              <button key={cat} onClick={() => setCategoryInput(cat)}
                style={{ flex:1, padding:'8px', border:'none', borderRadius:'4px', cursor:'pointer', fontSize:'12px', fontWeight:'bold',
                         background: categoryInput === cat ? '#C9A227' : 'transparent',
                         color:      categoryInput === cat ? '#0f1117' : '#888',
                         fontFamily:'Arial' }}>
                {CATEGORY_LABEL[cat]}
              </button>
            ))}
          </div>
          <button onClick={handleAdd} disabled={submitting || !plateInput}
            style={{ padding:'9px 16px', background: (submitting || !plateInput) ? '#2a2f3d' : '#C9A227', color: (submitting || !plateInput) ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'6px', cursor: (submitting || !plateInput) ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {error && <p style={{ color:'#f44336', fontSize:'12px', margin:'8px 0 0' }}>{error}</p>}
      {successMsg && <p style={{ color:'#4caf50', fontSize:'12px', margin:'8px 0 0' }}>{successMsg}</p>}

      {targetRemove && !readOnly && (
        <AuthorizedPlateRemoveConfirmModal
          target={targetRemove}
          propertyName={propertyName}
          onClose={() => setTargetRemove(null)}
          onConfirm={async () => { await handleRemove(targetRemove.id); setTargetRemove(null); }}
        />
      )}
    </div>
  )
}

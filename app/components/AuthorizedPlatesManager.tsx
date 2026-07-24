'use client'
// AP-MANAGE-CLIENT (2026-07-23): shared per-property manager for
// authorized_plates. Used by both /manager and /company_admin.
//
// Writes to `authorized_plates` ONLY. Per Jose's spec, this must not
// increment the PM-Only permit meter — a PM charged per staff plate
// simply won't add them. Grep for `.from('` in this file: authorized_plates
// must be the only referenced table.
//
// added_by / removed_by / removed_at are stamped server-side by the
// authorized_plates_normalize_and_attribute trigger. Client sends '' for
// added_by (empty string triggers fail-loud guard if JWT is unresolvable;
// a non-empty placeholder would satisfy the guard and land in audit
// verbatim). Client sends removed_at value to signal soft-delete intent;
// trigger overrides with now().
//
// Multi-property manager gap: mirrors Visitor Pass Quota Exemptions —
// settings tab renders one property's data implicitly. Pre-existing
// limitation, filed as docs/backlog/manager-multi-property-settings-selector.md.
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import AuthorizedPlateRemoveConfirmModal from './AuthorizedPlateRemoveConfirmModal'

interface AuthorizedPlate {
  id: number
  plate: string
  label: string | null
  added_by: string
  added_at: string
}

interface Props {
  propertyId: number
  propertyName: string
  onCountChange?: () => void
}

export default function AuthorizedPlatesManager({ propertyId, propertyName, onCountChange }: Props) {
  const [list, setList] = useState<AuthorizedPlate[]>([])
  const [plateInput, setPlateInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [targetRemove, setTargetRemove] = useState<AuthorizedPlate | null>(null)
  const [loading, setLoading] = useState(true)

  const refetchList = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('authorized_plates')
      .select('id, plate, label, added_by, added_at')
      .eq('property_id', propertyId)
      .is('removed_at', null)
      .order('added_at', { ascending: false })
    setList((data as AuthorizedPlate[]) ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { refetchList() }, [refetchList])

  async function handleAdd() {
    setError(null); setSuccessMsg(null)
    // Client-side normalize matches the trigger's UPPER(regexp_replace(...,'[^A-Za-z0-9]','','g')).
    const normalized = plateInput.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!normalized) { setError('Plate is required.'); return }

    setSubmitting(true)
    const { error: insErr } = await supabase.from('authorized_plates').insert({
      property_id: propertyId,
      plate: normalized,
      label: labelInput.trim() || null,
      added_by: '', // empty triggers fail-loud guard if JWT unresolvable; server override wins
    })
    setSubmitting(false)

    if (insErr) {
      if (insErr.code === '23505') {
        setError(`${normalized} is already authorized at ${propertyName}.`)
        return
      }
      setError(`Failed to add: ${insErr.message}`)
      return
    }

    setPlateInput(''); setLabelInput('')
    setSuccessMsg(`Added ${normalized} to ${propertyName}.`)
    setTimeout(() => setSuccessMsg(null), 5000)
    await refetchList()
    onCountChange?.()
  }

  async function handleRemove(id: number) {
    setError(null); setSuccessMsg(null)
    // .select('id') returns affected rows so we can detect RLS silent-refusal.
    // An UPDATE refused by RLS returns success with zero rows and no error —
    // the "success-on-zero-rows" failure the project already ate once. Verify
    // by evidence, not the success toast (standing rule).
    const { data, error: upErr } = await supabase
      .from('authorized_plates')
      .update({ removed_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')

    if (upErr) {
      // Friendly, non-diagnostic message. Do NOT interpret error code —
      // 23514 could be the trigger's removed_by-unresolvable RAISE OR any
      // of the four CHECK constraints. Lying-fallback class.
      setError('Remove failed — the server rejected the change. Refresh and try again; if it persists, contact support.')
      return
    }
    if (!data || data.length === 0) {
      setError('Remove failed — no rows updated. You may not have permission for this property.')
      return
    }
    await refetchList()
    onCountChange?.()
  }

  return (
    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
      <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Authorized Plates</p>
      {/* Boundary carried in the sub-copy (Mateo 2026-07-23): CA surface
          has no Visitor Pass Quota Exemptions section to contrast against,
          so this header text is the only thing distinguishing standing
          authorization from tow protection. Do not trim as verbose. */}
      <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>
        Staff, vendors, or contractors who regularly park at {propertyName}. These plates show as <strong style={{ color:'#4caf50' }}>Authorized</strong> when scanned — <strong>and can still be cited for violations</strong> like blocking a fire lane or occupying a reserved space.
      </p>

      {loading ? (
        <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px' }}>Loading…</p>
      ) : list.length === 0 ? (
        <div style={{ padding:'20px', textAlign:'center', color:'#888', border:'1px dashed #333', borderRadius:'8px', marginBottom:'14px' }}>
          <p style={{ fontSize:'14px', fontWeight:'bold', color:'#aaa', margin:'0 0 8px' }}>No authorized vehicles yet.</p>
          <p style={{ fontSize:'13px', margin:'0', lineHeight:'1.6' }}>
            Add staff, vendors, or contractors who park here regularly. Their plates will show as <strong style={{ color:'#4caf50' }}>Authorized</strong> when scanned — <strong>and can still be cited for violations</strong> like blocking a fire lane or occupying a reserved space.
          </p>
        </div>
      ) : (
        <div style={{ marginBottom:'14px' }}>
          {list.map(row => (
            <div key={row.id} style={{ padding:'10px 12px', background:'#1e2535', borderRadius:'6px', marginBottom:'6px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'8px' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:'white', fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold', letterSpacing:'0.08em' }}>{row.plate}</div>
                  {row.label && (
                    <div style={{ color:'#aaa', fontSize:'12px', fontStyle:'italic', marginTop:'3px', wordBreak:'break-word' }}>{row.label}</div>
                  )}
                  <div style={{ color:'#555', fontSize:'10px', marginTop:'4px' }}>Added by {row.added_by} · {new Date(row.added_at).toLocaleDateString()}</div>
                </div>
                <button onClick={() => setTargetRemove(row)}
                  style={{ padding:'3px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'5px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', flexShrink:0 }}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
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
        <button onClick={handleAdd} disabled={submitting || !plateInput}
          style={{ padding:'9px 16px', background: (submitting || !plateInput) ? '#2a2f3d' : '#C9A227', color: (submitting || !plateInput) ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'6px', cursor: (submitting || !plateInput) ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
          {submitting ? 'Adding…' : 'Add'}
        </button>
      </div>

      {error && <p style={{ color:'#f44336', fontSize:'12px', margin:'8px 0 0' }}>{error}</p>}
      {successMsg && <p style={{ color:'#4caf50', fontSize:'12px', margin:'8px 0 0' }}>{successMsg}</p>}

      {targetRemove && (
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

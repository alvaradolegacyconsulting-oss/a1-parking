'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '../../../supabase'
import { TIER_PRICING, TIER_DISPLAY_NAME, TierType } from '../../../lib/tier-config'
import { FEATURE_FLAGS, isNumericFlag, FeatureFlag } from '../../../lib/feature-flags'

type Status = 'draft' | 'issued' | 'redeemed' | 'expired' | 'revoked'

type ProposalRow = {
  id: number
  code: string
  prefix: string | null
  client_name: string | null
  client_email: string | null
  base_tier_type: TierType | null
  base_tier: string | null
  expires_at: string | null
  custom_base_fee: number | null
  custom_per_property_fee: number | null
  custom_per_driver_fee: number | null
  feature_overrides: Record<string, boolean | number> | null
  notes: string | null
  status: Status
  generated_at: string | null
  generated_by: string | null
  issued_at: string | null
  issued_by: string | null
  redeemed_at: string | null
  revoked_at: string | null
  revoke_reason: string | null
  pdf_url: string | null
  company_id: number | null
}

type Company = { id: number; name: string; tier?: string | null; tier_type?: string | null }

const VALID_FLAGS = new Set(Object.values(FEATURE_FLAGS))

function validateFeatureOverrides(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return { valid: true as const, value: {} }
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return { valid: false as const, error: 'Invalid JSON' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false as const, error: 'Must be a JSON object' }
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!VALID_FLAGS.has(key as FeatureFlag)) return { valid: false as const, error: `Unknown flag: "${key}"` }
    if (isNumericFlag(key as FeatureFlag)) {
      if (typeof value !== 'number') return { valid: false as const, error: `"${key}" expects a number` }
    } else {
      if (typeof value !== 'boolean') return { valid: false as const, error: `"${key}" expects a boolean` }
    }
  }
  return { valid: true as const, value: parsed as Record<string, boolean | number> }
}

const inp: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: '6px', marginBottom: '14px',
  padding: '10px 12px', fontSize: '13px', background: '#1e2535',
  border: '1px solid #3a4055', borderRadius: '8px', color: 'white',
  outline: 'none', boxSizing: 'border-box', fontFamily: 'Arial',
}
const lbl: React.CSSProperties = { color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em' }
const ro: React.CSSProperties = { color: 'white', fontSize: '13px', margin: '4px 0 14px' }

function effectiveStatus(row: ProposalRow): Status {
  if (row.status === 'issued' && row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return 'expired'
  }
  return row.status
}

const STATUS_BADGE: Record<Status, { bg: string; fg: string; border: string }> = {
  draft: { bg: '#1e2535', fg: '#aaa', border: '#3a4055' },
  issued: { bg: '#0e1a2a', fg: '#4fc3f7', border: '#0288d1' },
  redeemed: { bg: '#0d1f0d', fg: '#4caf50', border: '#2e7d32' },
  expired: { bg: '#2a1f0a', fg: '#fbbf24', border: '#a16207' },
  revoked: { bg: '#3a1a1a', fg: '#f44336', border: '#b71c1c' },
}

export default function ProposalCodeDetail() {
  const router = useRouter()
  const params = useParams<{ code: string }>()
  const code = params?.code

  const [authChecked, setAuthChecked] = useState(false)
  const [row, setRow] = useState<ProposalRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string>('')
  const [busy, setBusy] = useState(false)

  // Edit state (drafts only)
  const [clientName, setClientName] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [tierType, setTierType] = useState<TierType>('enforcement')
  const [tier, setTier] = useState<string>('legacy')
  const [expiresAt, setExpiresAt] = useState<string>('')
  const [customBaseFee, setCustomBaseFee] = useState<string>('')
  const [customPerProperty, setCustomPerProperty] = useState<string>('')
  const [customPerDriver, setCustomPerDriver] = useState<string>('')
  const [overridesText, setOverridesText] = useState<string>('')
  const [notes, setNotes] = useState<string>('')

  // Apply-to-company modal
  const [applyOpen, setApplyOpen] = useState(false)
  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('')

  // Revoke modal
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeReason, setRevokeReason] = useState('')

  // Delete-draft confirm
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      const { data: roleData } = await supabase
        .from('user_roles').select('role').ilike('email', user.email!).single()
      if (roleData?.role !== 'admin') { window.location.href = '/'; return }
      setAuthChecked(true)
      await load()
    })()
  }, [code])

  async function load() {
    if (!code) return
    setLoading(true)
    const { data, error } = await supabase
      .from('proposal_codes')
      .select('*')
      .eq('code', code)
      .single()
    setLoading(false)
    if (error || !data) { setMsg(error?.message || 'Not found'); return }
    const r = data as ProposalRow
    setRow(r)
    setClientName(r.client_name || '')
    setClientEmail(r.client_email || '')
    setTierType((r.base_tier_type as TierType) || 'enforcement')
    setTier(r.base_tier || 'legacy')
    setExpiresAt(r.expires_at || '')
    setCustomBaseFee(r.custom_base_fee != null ? String(r.custom_base_fee) : '')
    setCustomPerProperty(r.custom_per_property_fee != null ? String(r.custom_per_property_fee) : '')
    setCustomPerDriver(r.custom_per_driver_fee != null ? String(r.custom_per_driver_fee) : '')
    setOverridesText(r.feature_overrides && Object.keys(r.feature_overrides).length ? JSON.stringify(r.feature_overrides, null, 2) : '')
    setNotes(r.notes || '')
  }

  const eff: Status | null = row ? effectiveStatus(row) : null
  const isDraft = eff === 'draft'
  const overrideValidation = useMemo(() => validateFeatureOverrides(overridesText), [overridesText])

  const perPropertyDefault = (() => {
    if (tierType === 'enforcement') return tier === 'starter' ? 15 : tier === 'growth' ? 12 : 10
    return tier === 'essential' ? 20 : tier === 'professional' ? 15 : 10
  })()
  const perDriverDefault = tierType === 'enforcement'
    ? (tier === 'starter' ? 10 : tier === 'growth' ? 8 : 6)
    : 0
  const baseDefault = TIER_PRICING[tierType]?.[tier] ?? 0

  async function saveDraft() {
    if (!row || !isDraft) return
    if (!overrideValidation.valid) { setMsg(overrideValidation.error); return }
    setMsg(''); setBusy(true)
    const { error } = await supabase
      .from('proposal_codes')
      .update({
        client_name: clientName.trim() || null,
        client_email: clientEmail.trim() || null,
        base_tier_type: tierType,
        base_tier: tier,
        expires_at: expiresAt || null,
        custom_base_fee: customBaseFee === '' ? null : Number(customBaseFee),
        custom_per_property_fee: customPerProperty === '' ? null : Number(customPerProperty),
        custom_per_driver_fee: tierType === 'enforcement'
          ? (customPerDriver === '' ? null : Number(customPerDriver))
          : null,
        feature_overrides: overrideValidation.value,
        notes: notes.trim() || null,
      })
      .eq('id', row.id)
    setBusy(false)
    if (error) { setMsg('Save failed: ' + error.message); return }
    setMsg('Draft saved.')
    setTimeout(() => setMsg(''), 2500)
    await load()
  }

  async function deleteDraft() {
    if (!row || !isDraft) return
    setBusy(true)
    const { error } = await supabase.from('proposal_codes').delete().eq('id', row.id)
    setBusy(false)
    if (error) { setMsg('Delete failed: ' + error.message); return }
    router.push('/admin/proposal-codes')
  }

  async function issueCode() {
    if (!row || !isDraft) return
    if (!overrideValidation.valid) { setMsg(overrideValidation.error); return }
    if (!confirm('Issue this code? Status will transition to issued and the code becomes immutable. PDF generation is currently manual — see docs/hand-gen-pdf.md.')) return
    setBusy(true)
    setMsg('Issuing…')
    const res = await fetch(`/api/proposal-codes/${row.id}/issue`, { method: 'POST' })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setMsg('Issue failed: ' + (body.error || res.statusText))
      return
    }
    setMsg('Code issued. PDF generation pending — see docs/hand-gen-pdf.md to create and upload the PDF.')
    await load()
  }

  async function viewPdf() {
    if (!row) return
    if (!row.pdf_url) {
      setMsg('PDF Pending — upload via the hand-gen workflow (see docs/hand-gen-pdf.md) and set pdf_url on the row.')
      return
    }
    setBusy(true)
    const res = await fetch(`/api/proposal-codes/${row.id}/pdf-url`, { method: 'GET' })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setMsg('View PDF failed: ' + (body.error || res.statusText))
      return
    }
    const body = await res.json()
    if (body.url) window.open(body.url, '_blank')
  }

  async function openApplyModal() {
    setApplyOpen(true)
    if (companies.length === 0) {
      const { data } = await supabase.from('companies').select('id, name, tier, tier_type').order('name')
      setCompanies((data as Company[]) || [])
    }
  }

  async function applyToCompany() {
    if (!row || !selectedCompanyId) return
    setBusy(true)
    const { error } = await supabase
      .from('proposal_codes')
      .update({ company_id: Number(selectedCompanyId), status: 'redeemed', redeemed_at: new Date().toISOString() })
      .eq('id', row.id)
    setBusy(false)
    if (error) { setMsg('Apply failed: ' + error.message); return }
    setApplyOpen(false)
    setSelectedCompanyId('')
    await load()
  }

  async function revoke() {
    if (!row) return
    if (!revokeReason.trim()) { setMsg('Provide a revoke reason.'); return }
    setBusy(true)
    const { error } = await supabase
      .from('proposal_codes')
      .update({ status: 'revoked', revoked_at: new Date().toISOString(), revoke_reason: revokeReason.trim() })
      .eq('id', row.id)
    setBusy(false)
    if (error) { setMsg('Revoke failed: ' + error.message); return }
    setRevokeOpen(false)
    setRevokeReason('')
    await load()
  }

  if (!authChecked || loading) {
    return <main style={{ minHeight: '100vh', background: '#0f1117', color: '#888', fontFamily: 'Arial, sans-serif', padding: '40px', textAlign: 'center' }}>Loading…</main>
  }

  if (!row) {
    return (
      <main style={{ minHeight: '100vh', background: '#0f1117', color: '#888', fontFamily: 'Arial, sans-serif', padding: '40px', textAlign: 'center' }}>
        <p>{msg || 'Not found.'}</p>
        <a href="/admin/proposal-codes" style={{ color: '#C9A227' }}>← Back to list</a>
      </main>
    )
  }

  const status = eff!
  const badge = STATUS_BADGE[status]
  const tierOptions = tierType === 'enforcement'
    ? ['starter', 'growth', 'legacy']
    : ['essential', 'professional', 'enterprise']

  const btnGold: React.CSSProperties = { padding: '10px 14px', background: '#C9A227', color: '#0f1117', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }
  const btnGhost: React.CSSProperties = { padding: '10px 14px', background: '#1e2535', color: '#aaa', fontSize: '13px', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }
  const btnDanger: React.CSSProperties = { padding: '10px 14px', background: '#3a1a1a', color: '#f44336', fontSize: '13px', border: '1px solid #b71c1c', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ maxWidth: '700px', margin: '0 auto' }}>

        <a href="/admin/proposal-codes" style={{ color: '#C9A227', fontSize: '12px', textDecoration: 'none' }}>← Back to list</a>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0 18px' }}>
          <div>
            <h1 style={{ color: '#C9A227', fontSize: '22px', fontWeight: 'bold', margin: 0, fontFamily: 'Courier New' }}>{row.code}</h1>
            <p style={{ color: '#888', fontSize: '12px', margin: '4px 0 0' }}>
              {row.client_name || '—'} · created {row.generated_at ? new Date(row.generated_at).toLocaleString() : '—'}
            </p>
          </div>
          <span style={{ background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`, padding: '4px 12px', borderRadius: '14px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {status}
          </span>
        </div>

        {msg && (
          <div style={{ background: msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('invalid') ? '#3a1a1a' : '#0d1f0d', border: `1px solid ${msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('invalid') ? '#b71c1c' : '#2e7d32'}`, borderRadius: '8px', padding: '10px 14px', marginBottom: '14px' }}>
            <p style={{ color: msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('invalid') ? '#f44336' : '#4caf50', fontSize: '12px', margin: 0 }}>{msg}</p>
          </div>
        )}

        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '12px', padding: '20px', marginBottom: '14px' }}>

          {/* Editable form (drafts) OR read-only summary */}
          {isDraft ? (
            <>
              <label style={lbl}>Client Name</label>
              <input value={clientName} onChange={e => setClientName(e.target.value)} style={inp} />

              <label style={lbl}>Client Email</label>
              <input type="email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} style={inp} />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={lbl}>Base Tier Type</label>
                  <select value={tierType} onChange={e => { const t = e.target.value as TierType; setTierType(t); setTier(t === 'enforcement' ? 'legacy' : 'professional') }} style={inp}>
                    <option value="enforcement">Enforcement</option>
                    <option value="property_management">Property Management</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Base Tier</label>
                  <select value={tier} onChange={e => setTier(e.target.value)} style={inp}>
                    {tierOptions.map(t => <option key={t} value={t}>{TIER_DISPLAY_NAME[tierType]?.[t] || t}</option>)}
                  </select>
                </div>
              </div>

              <label style={lbl}>Expires At (ISO)</label>
              <input value={expiresAt} onChange={e => setExpiresAt(e.target.value)} placeholder="2026-06-09T00:00:00Z" style={inp} />

              <label style={lbl}>Custom Base Fee ($/mo)</label>
              <input type="number" step="0.01" min={0} value={customBaseFee} onChange={e => setCustomBaseFee(e.target.value)} placeholder={`Default: $${baseDefault}`} style={inp} />

              <label style={lbl}>Custom Per-Property Fee ($/mo)</label>
              <input type="number" step="0.01" min={0} value={customPerProperty} onChange={e => setCustomPerProperty(e.target.value)} placeholder={`Default: $${perPropertyDefault}`} style={inp} />

              {tierType === 'enforcement' && (
                <>
                  <label style={lbl}>Custom Per-Driver Fee ($/mo)</label>
                  <input type="number" step="0.01" min={0} value={customPerDriver} onChange={e => setCustomPerDriver(e.target.value)} placeholder={`Default: $${perDriverDefault}`} style={inp} />
                </>
              )}

              <label style={lbl}>Feature Overrides (JSON)</label>
              <textarea value={overridesText} onChange={e => setOverridesText(e.target.value)}
                placeholder='{"max_properties": 50, "advanced_analytics": true}'
                style={{ ...inp, minHeight: '110px', fontFamily: 'Courier New', resize: 'vertical' as const }} />
              {!overrideValidation.valid && (
                <p style={{ color: '#f44336', fontSize: '11px', margin: '-10px 0 14px' }}>{overrideValidation.error}</p>
              )}

              <label style={lbl}>Notes (internal)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inp, minHeight: '60px', resize: 'vertical' as const }} />
            </>
          ) : (
            <>
              <label style={lbl}>Client</label>
              <p style={ro}>{row.client_name || '—'} · <span style={{ color: '#888' }}>{row.client_email || '—'}</span></p>

              <label style={lbl}>Base Tier</label>
              <p style={ro}>
                {row.base_tier_type === 'enforcement' ? 'Enforcement' : 'Property Management'} ·{' '}
                {row.base_tier ? (TIER_DISPLAY_NAME[(row.base_tier_type || 'enforcement') as TierType]?.[row.base_tier] || row.base_tier) : '—'}
              </p>

              <label style={lbl}>Expires</label>
              <p style={ro}>{row.expires_at ? new Date(row.expires_at).toLocaleString() : '—'}</p>

              <label style={lbl}>Custom Pricing</label>
              <p style={ro}>
                Base: {row.custom_base_fee != null ? `$${row.custom_base_fee}` : <span style={{ color: '#555' }}>tier default</span>}
                {' · '}
                Per Property: {row.custom_per_property_fee != null ? `$${row.custom_per_property_fee}` : <span style={{ color: '#555' }}>tier default</span>}
                {row.base_tier_type === 'enforcement' && (
                  <>{' · '}Per Driver: {row.custom_per_driver_fee != null ? `$${row.custom_per_driver_fee}` : <span style={{ color: '#555' }}>tier default</span>}</>
                )}
              </p>

              <label style={lbl}>Feature Overrides</label>
              <pre style={{ ...ro, background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: '6px', padding: '8px 10px', fontFamily: 'Courier New', fontSize: '11px', overflow: 'auto' }}>
                {row.feature_overrides && Object.keys(row.feature_overrides).length
                  ? JSON.stringify(row.feature_overrides, null, 2)
                  : '(none)'}
              </pre>

              {row.notes && (<>
                <label style={lbl}>Notes</label>
                <p style={ro}>{row.notes}</p>
              </>)}

              {(status === 'issued' || status === 'redeemed' || status === 'expired' || status === 'revoked') && (<>
                <label style={lbl}>Lifecycle</label>
                <p style={{ ...ro, color: '#888', fontSize: '11px' }}>
                  Drafted by {row.generated_by || '—'} · {row.generated_at ? new Date(row.generated_at).toLocaleString() : '—'}<br />
                  {row.issued_at && <>Issued by {row.issued_by || '—'} · {new Date(row.issued_at).toLocaleString()}<br /></>}
                  {row.redeemed_at && <>Redeemed · {new Date(row.redeemed_at).toLocaleString()}<br /></>}
                  {row.revoked_at && <>Revoked · {new Date(row.revoked_at).toLocaleString()}<br /></>}
                </p>
              </>)}

              {status === 'revoked' && row.revoke_reason && (<>
                <label style={lbl}>Revoke Reason</label>
                <p style={{ ...ro, color: '#f44336' }}>{row.revoke_reason}</p>
              </>)}
            </>
          )}
        </div>

        {/* Hand-gen workflow notice — only relevant while a code is a
            draft (the only state from which a PDF can be uploaded). */}
        {isDraft && (
          <div style={{ background: '#1a1f2e', border: '1px solid #3a4055', borderRadius: '8px', padding: '10px 14px', marginBottom: '10px' }}>
            <p style={{ color: '#aaa', fontSize: '12px', margin: 0, lineHeight: 1.6 }}>
              PDF preview unavailable. Use the hand-gen workflow (see <code style={{ color: '#C9A227' }}>docs/hand-gen-pdf.md</code>) to create the PDF before issuing.
            </p>
          </div>
        )}

        {/* Action bar — varies by status */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {isDraft && (<>
            <button onClick={saveDraft} disabled={busy || !overrideValidation.valid} style={{ ...btnGold, opacity: busy || !overrideValidation.valid ? 0.5 : 1 }}>Save Draft</button>
            <button onClick={issueCode} disabled={busy} style={btnGold}>Issue Code</button>
            <button onClick={() => setDeleteOpen(true)} style={btnDanger}>Delete Draft</button>
          </>)}
          {status === 'issued' && (<>
            <button onClick={viewPdf} disabled={!row.pdf_url} style={{ ...btnGhost, opacity: row.pdf_url ? 1 : 0.5, cursor: row.pdf_url ? 'pointer' : 'not-allowed' }}>
              {row.pdf_url ? 'View PDF' : 'PDF Pending'}
            </button>
            <button onClick={openApplyModal} style={btnGold}>Apply to Company</button>
            <button onClick={() => setRevokeOpen(true)} style={btnDanger}>Revoke</button>
          </>)}
          {status === 'redeemed' && (<>
            <button onClick={viewPdf} disabled={!row.pdf_url} style={{ ...btnGhost, opacity: row.pdf_url ? 1 : 0.5, cursor: row.pdf_url ? 'pointer' : 'not-allowed' }}>
              {row.pdf_url ? 'View PDF' : 'PDF Pending'}
            </button>
            {row.company_id && (
              <a href={`/admin?company_id=${row.company_id}`} style={{ ...btnGhost, textDecoration: 'none', display: 'inline-block' }}>View Company</a>
            )}
          </>)}
          {(status === 'expired' || status === 'revoked') && (
            <button onClick={viewPdf} disabled={!row.pdf_url} style={{ ...btnGhost, opacity: row.pdf_url ? 1 : 0.5, cursor: row.pdf_url ? 'pointer' : 'not-allowed' }}>
              {row.pdf_url ? 'View PDF' : 'PDF Pending'}
            </button>
          )}
        </div>

        {/* Apply modal */}
        {applyOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ background: '#161b26', border: '1px solid #C9A227', borderRadius: '12px', padding: '24px', width: '420px', maxWidth: '90%' }}>
              <h2 style={{ color: '#C9A227', fontSize: '16px', fontWeight: 'bold', margin: '0 0 12px' }}>Apply Code to Company</h2>
              <p style={{ color: '#888', fontSize: '12px', margin: '0 0 14px', lineHeight: 1.6 }}>
                The selected company will be marked as having redeemed this proposal. Pricing and feature overrides take effect on their next login.
              </p>
              <label style={lbl}>Company</label>
              <select value={selectedCompanyId} onChange={e => setSelectedCompanyId(e.target.value)} style={inp}>
                <option value="">— Select —</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <button onClick={applyToCompany} disabled={!selectedCompanyId || busy} style={{ ...btnGold, flex: 1, opacity: !selectedCompanyId || busy ? 0.5 : 1 }}>Apply</button>
                <button onClick={() => { setApplyOpen(false); setSelectedCompanyId('') }} style={btnGhost}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Revoke modal */}
        {revokeOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ background: '#161b26', border: '1px solid #b71c1c', borderRadius: '12px', padding: '24px', width: '420px', maxWidth: '90%' }}>
              <h2 style={{ color: '#f44336', fontSize: '16px', fontWeight: 'bold', margin: '0 0 12px' }}>Revoke Proposal</h2>
              <p style={{ color: '#888', fontSize: '12px', margin: '0 0 14px', lineHeight: 1.6 }}>
                Revoking is permanent. The code becomes inert. To re-offer, create a new draft.
              </p>
              <label style={lbl}>Reason</label>
              <textarea value={revokeReason} onChange={e => setRevokeReason(e.target.value)}
                placeholder="Why this is being revoked"
                style={{ ...inp, minHeight: '80px', resize: 'vertical' as const }} />
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <button onClick={revoke} disabled={!revokeReason.trim() || busy} style={{ ...btnDanger, flex: 1, opacity: !revokeReason.trim() || busy ? 0.5 : 1 }}>Revoke</button>
                <button onClick={() => { setRevokeOpen(false); setRevokeReason('') }} style={btnGhost}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Delete-draft confirm */}
        {deleteOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ background: '#161b26', border: '1px solid #b71c1c', borderRadius: '12px', padding: '24px', width: '380px', maxWidth: '90%' }}>
              <h2 style={{ color: '#f44336', fontSize: '16px', fontWeight: 'bold', margin: '0 0 12px' }}>Delete Draft?</h2>
              <p style={{ color: '#aaa', fontSize: '12px', margin: '0 0 14px' }}>
                <strong style={{ color: '#C9A227', fontFamily: 'Courier New' }}>{row.code}</strong> will be permanently removed.
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={deleteDraft} disabled={busy} style={{ ...btnDanger, flex: 1 }}>Delete</button>
                <button onClick={() => setDeleteOpen(false)} style={btnGhost}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

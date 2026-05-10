'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../supabase'
import { TIER_CONFIG, TIER_PRICING, TIER_DISPLAY_NAME, TierType } from '../../../lib/tier-config'
import { FEATURE_FLAGS, isNumericFlag, FeatureFlag } from '../../../lib/feature-flags'

const VALID_FLAGS = new Set(Object.values(FEATURE_FLAGS))

type Validation = { valid: true; value: Record<string, boolean | number> } | { valid: false; error: string }

function validateFeatureOverrides(text: string): Validation {
  const trimmed = text.trim()
  if (!trimmed) return { valid: true, value: {} }
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) }
  catch { return { valid: false, error: 'Invalid JSON' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Must be a JSON object, e.g. {"max_properties": 50}' }
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!VALID_FLAGS.has(key as FeatureFlag)) {
      return { valid: false, error: `Unknown flag: "${key}"` }
    }
    if (isNumericFlag(key as FeatureFlag)) {
      if (typeof value !== 'number') return { valid: false, error: `"${key}" expects a number` }
    } else {
      if (typeof value !== 'boolean') return { valid: false, error: `"${key}" expects a boolean` }
    }
  }
  return { valid: true, value: parsed as Record<string, boolean | number> }
}

const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
function genSuffix(): string {
  return Array.from({ length: 4 }, () => SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)]).join('')
}

const inp: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: '6px', marginBottom: '14px',
  padding: '10px 12px', fontSize: '13px', background: '#1e2535',
  border: '1px solid #3a4055', borderRadius: '8px', color: 'white',
  outline: 'none', boxSizing: 'border-box', fontFamily: 'Arial',
}
const lbl: React.CSSProperties = { color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em' }

const ENFORCEMENT_TIERS = ['starter', 'growth', 'legacy'] as const
const PM_TIERS = ['essential', 'professional', 'enterprise'] as const

export default function NewProposalCode() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [adminEmail, setAdminEmail] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string>('')

  const [prefix, setPrefix] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [tierType, setTierType] = useState<TierType>('enforcement')
  const [tier, setTier] = useState<string>('legacy')
  const [expiresInDays, setExpiresInDays] = useState<number>(30)
  const [customBaseFee, setCustomBaseFee] = useState<string>('')
  const [customPerProperty, setCustomPerProperty] = useState<string>('')
  const [customPerDriver, setCustomPerDriver] = useState<string>('')
  const [overridesText, setOverridesText] = useState<string>('')
  const [notes, setNotes] = useState<string>('')

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      const { data: roleData } = await supabase
        .from('user_roles').select('role').ilike('email', user.email!).single()
      if (roleData?.role !== 'admin') { window.location.href = '/'; return }
      setAdminEmail(user.email || '')
      setAuthChecked(true)
    })()
  }, [])

  // Reset tier when type changes
  useEffect(() => {
    setTier(tierType === 'enforcement' ? 'legacy' : 'professional')
  }, [tierType])

  const tierDefaults = useMemo(() => {
    const cfg = TIER_CONFIG[tierType]?.[tier]
    const base = TIER_PRICING[tierType]?.[tier] ?? 0
    return {
      base,
      perProperty: cfg && typeof cfg['max_properties' as FeatureFlag] === 'number' ? null : null, // placeholder lookup not needed
      maxProps: (cfg?.[FEATURE_FLAGS.MAX_PROPERTIES] as number) ?? 0,
    }
  }, [tierType, tier])

  // Hardcoded per-property/per-driver defaults from Pricing v2 — kept here
  // because TIER_PRICING only stores the base fee. Mirror of admin pricing UI.
  const perPropertyDefault = (() => {
    if (tierType === 'enforcement') {
      return tier === 'starter' ? 15 : tier === 'growth' ? 12 : 10
    }
    return tier === 'essential' ? 20 : tier === 'professional' ? 15 : 10
  })()
  const perDriverDefault = tierType === 'enforcement'
    ? (tier === 'starter' ? 10 : tier === 'growth' ? 8 : 6)
    : 0

  const overrideValidation = validateFeatureOverrides(overridesText)

  const prefixRegex = /^[A-Z0-9_]{1,16}$/
  const prefixOk = prefixRegex.test(prefix)
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)
  const expiresOk = Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
  const numOk = (s: string) => s === '' || (!isNaN(Number(s)) && Number(s) >= 0)
  const allOk = prefixOk && clientName.trim() && emailOk && expiresOk
    && numOk(customBaseFee) && numOk(customPerProperty) && numOk(customPerDriver)
    && overrideValidation.valid

  async function submit() {
    setErr('')
    if (!overrideValidation.valid) { setErr(overrideValidation.error); return }
    if (!allOk) { setErr('Please fix the errors above before submitting.'); return }
    setSubmitting(true)

    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString()
    const payload: Record<string, unknown> = {
      prefix,
      client_name: clientName.trim(),
      client_email: clientEmail.trim(),
      base_tier_type: tierType,
      base_tier: tier,
      expires_at: expiresAt,
      custom_base_fee: customBaseFee === '' ? null : Number(customBaseFee),
      custom_per_property_fee: customPerProperty === '' ? null : Number(customPerProperty),
      custom_per_driver_fee: tierType === 'enforcement'
        ? (customPerDriver === '' ? null : Number(customPerDriver))
        : null,
      feature_overrides: overrideValidation.value,
      notes: notes.trim() || null,
      status: 'draft',
      generated_at: new Date().toISOString(),
      generated_by: adminEmail,
    }

    let lastErr: string | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = `${prefix}-${genSuffix()}`
      const { data, error } = await supabase
        .from('proposal_codes')
        .insert([{ ...payload, code }])
        .select('code')
        .single()
      if (!error && data) {
        router.push(`/admin/proposal-codes/${data.code}`)
        return
      }
      // 23505 = unique violation
      if ((error as { code?: string } | null)?.code === '23505') { lastErr = 'collision'; continue }
      setErr(error?.message || 'Insert failed')
      setSubmitting(false)
      return
    }
    setErr(`Could not generate unique code after 5 attempts (last: ${lastErr}). Try a different prefix.`)
    setSubmitting(false)
  }

  if (!authChecked) {
    return <main style={{ minHeight: '100vh', background: '#0f1117', color: '#888', fontFamily: 'Arial, sans-serif', padding: '40px', textAlign: 'center' }}>Checking access…</main>
  }

  const tierOptions = tierType === 'enforcement' ? ENFORCEMENT_TIERS : PM_TIERS

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>

        <div style={{ marginBottom: '20px' }}>
          <a href="/admin/proposal-codes" style={{ color: '#C9A227', fontSize: '12px', textDecoration: 'none' }}>← Back to list</a>
          <h1 style={{ color: '#C9A227', fontSize: '22px', fontWeight: 'bold', margin: '8px 0 0' }}>New Proposal Code</h1>
          <p style={{ color: '#888', fontSize: '12px', margin: '4px 0 0' }}>
            Drafted as <strong>{adminEmail}</strong>. Code is editable until issued.
          </p>
        </div>

        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '12px', padding: '20px' }}>

          <label style={lbl}>Prefix (max 16 chars, [A-Z0-9_])</label>
          <input
            value={prefix}
            onChange={e => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16))}
            placeholder="A1WRECKER"
            style={{ ...inp, fontFamily: 'Courier New', letterSpacing: '0.05em' }}
          />
          {!prefixOk && prefix.length > 0 && (
            <p style={{ color: '#f44336', fontSize: '11px', margin: '-10px 0 14px' }}>Prefix must be 1–16 chars of A-Z, 0-9, or underscore.</p>
          )}
          {prefixOk && (
            <p style={{ color: '#555', fontSize: '11px', margin: '-10px 0 14px' }}>Full code will be e.g. <span style={{ color: '#C9A227', fontFamily: 'Courier New' }}>{prefix}-XXXX</span></p>
          )}

          <label style={lbl}>Client Name</label>
          <input value={clientName} onChange={e => setClientName(e.target.value)} placeholder="A1 Wrecker LLC" style={inp} />

          <label style={lbl}>Client Email</label>
          <input type="email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} placeholder="jose@a1wrecker.com" style={inp} />
          {clientEmail && !emailOk && (
            <p style={{ color: '#f44336', fontSize: '11px', margin: '-10px 0 14px' }}>Invalid email.</p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={lbl}>Base Tier Type</label>
              <select value={tierType} onChange={e => setTierType(e.target.value as TierType)} style={inp}>
                <option value="enforcement">Enforcement</option>
                <option value="property_management">Property Management</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Base Tier</label>
              <select value={tier} onChange={e => setTier(e.target.value)} style={inp}>
                {tierOptions.map(t => (
                  <option key={t} value={t}>{TIER_DISPLAY_NAME[tierType]?.[t] || t}</option>
                ))}
              </select>
            </div>
          </div>

          <label style={lbl}>Expires In (days)</label>
          <input type="number" min={1} max={365} value={expiresInDays}
            onChange={e => setExpiresInDays(parseInt(e.target.value) || 30)} style={inp} />

          <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '14px 0 6px' }}>
            Pricing overrides
          </p>
          <p style={{ color: '#555', fontSize: '11px', margin: '0 0 10px' }}>
            Leave blank to use the tier&apos;s default. Override = the price this client pays.
          </p>

          <label style={lbl}>Custom Base Fee ($/mo)</label>
          <input type="number" step="0.01" min={0} value={customBaseFee}
            onChange={e => setCustomBaseFee(e.target.value)}
            placeholder={`Default: $${tierDefaults.base}`} style={inp} />

          <label style={lbl}>Custom Per-Property Fee ($/mo)</label>
          <input type="number" step="0.01" min={0} value={customPerProperty}
            onChange={e => setCustomPerProperty(e.target.value)}
            placeholder={`Default: $${perPropertyDefault}`} style={inp} />

          {tierType === 'enforcement' && (
            <>
              <label style={lbl}>Custom Per-Driver Fee ($/mo)</label>
              <input type="number" step="0.01" min={0} value={customPerDriver}
                onChange={e => setCustomPerDriver(e.target.value)}
                placeholder={`Default: $${perDriverDefault}`} style={inp} />
            </>
          )}

          <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '14px 0 6px' }}>
            Feature overrides (JSON)
          </p>
          <p style={{ color: '#555', fontSize: '11px', margin: '0 0 10px' }}>
            Per-flag overrides applied on top of the tier defaults. Keys must match feature-flags.ts.
          </p>
          <textarea
            value={overridesText}
            onChange={e => setOverridesText(e.target.value)}
            placeholder='{"max_properties": 50, "advanced_analytics": true}'
            style={{ ...inp, minHeight: '110px', fontFamily: 'Courier New', resize: 'vertical' as const }}
          />
          {!overrideValidation.valid && (
            <p style={{ color: '#f44336', fontSize: '11px', margin: '-10px 0 14px' }}>
              {overrideValidation.error}
            </p>
          )}

          <label style={lbl}>Notes (internal)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Deal context, why we offered this, etc."
            style={{ ...inp, minHeight: '60px', resize: 'vertical' as const }} />

          {err && (
            <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px' }}>
              <p style={{ color: '#f44336', fontSize: '12px', margin: 0 }}>{err}</p>
            </div>
          )}

          <button onClick={submit} disabled={!allOk || submitting}
            style={{
              width: '100%', padding: '12px', fontWeight: 'bold', fontSize: '14px',
              background: !allOk || submitting ? '#3a4055' : '#C9A227',
              color: !allOk || submitting ? '#888' : '#0f1117',
              border: 'none', borderRadius: '8px',
              cursor: !allOk || submitting ? 'not-allowed' : 'pointer', fontFamily: 'Arial',
            }}>
            {submitting ? 'Creating draft…' : 'Create Draft'}
          </button>
        </div>

      </div>
    </main>
  )
}

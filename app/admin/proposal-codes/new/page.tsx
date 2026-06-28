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

// Slice 1 Commit 5 (2026-06-26) — proposal-code tier choices updated
// to the new 3-tier model. Each track has a single self-serve tier
// plus Legacy (negotiated). Custom proposals can target any of the 3
// per Jose's locked decision.
//   pm_only:          PM-Only — flat per-permit override available
//   enforcement_only: Enforcement-Only — no permit billing
//   legacy:           Legacy negotiated — no permit billing (unmetered)
// Old 6-tier values intentionally NOT in the dropdown for new proposals.
// Existing proposal_codes with old base_tier values display via
// TIER_DISPLAY_NAME back-compat in [code]/page.tsx (no breakage).
const ENFORCEMENT_TIERS = ['enforcement_only', 'legacy'] as const
const PM_TIERS = ['pm_only', 'legacy'] as const

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
  // Slice 1 Commit 5 — default tier for new proposals: enforcement_only
  // (matches the default tierType='enforcement' starting state). Reset
  // useEffect below updates this when tierType toggles.
  const [tier, setTier] = useState<string>('enforcement_only')
  const [expiresInDays, setExpiresInDays] = useState<number>(30)
  const [customBaseFee, setCustomBaseFee] = useState<string>('')
  const [customPerProperty, setCustomPerProperty] = useState<string>('')
  // Slice 1 Commit 5 — customPerDriver state removed (per_driver retired).
  // Form field removed below; payload always sends custom_per_driver_fee=null;
  // validation reference dropped too.
  // Slice 1 Commit 5 — NEW: per-permit override (PM-Only deals only).
  // Single flat $/permit rate (NOT graduated — graduated is standard-
  // catalog only, custom proposals get a flat negotiated rate per
  // Jose's locked Legacy/PM-Only permit shape decision). Writes to
  // proposal_codes.custom_per_permit_fee NUMERIC column. Stripe-side
  // issue-time creation of the corresponding flat per_permit Price
  // is deferred to a future commit per the migration's header note.
  const [customPerPermit, setCustomPerPermit] = useState<string>('')
  const [lockInMonths, setLockInMonths] = useState<string>('')
  // B66.7 Option γ — admin captures negotiated quantities at code creation;
  // start-billing route passes these as Stripe Subscription line-item
  // quantities at redeem. Blank → NULL on insert (and 1 at start-billing).
  const [includedProperties, setIncludedProperties] = useState<string>('')
  // Slice 1 Commit 5 — includedDrivers state removed (per_driver retired).
  // Form field gone; payload always sends included_drivers=null.
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

  // Reset tier when type changes. Slice 1 Commit 5 — new default tiers
  // per track (the single self-serve tier in each).
  useEffect(() => {
    setTier(tierType === 'enforcement' ? 'enforcement_only' : 'pm_only')
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

  // Slice 1 Commit 5 — defaults updated for new 3-tier model.
  // pm_only       = $20/property (matches platform_settings seed)
  // enforcement_only = $15/property (matches platform_settings seed)
  // legacy        = no default (negotiated; UI shows blank)
  // Old 6-tier defaults kept inline for the back-compat display of
  // OLD proposal_codes only; new dropdown options (enforcement_only,
  // pm_only, legacy) hit the new branches first.
  const perPropertyDefault = (() => {
    if (tierType === 'enforcement') {
      if (tier === 'enforcement_only') return 15
      if (tier === 'legacy') return 0  // negotiated; no default
      // Back-compat for OLD tier display:
      return tier === 'starter' ? 15 : tier === 'growth' ? 12 : 10
    }
    if (tier === 'pm_only') return 20
    if (tier === 'legacy') return 0  // negotiated; no default
    // Back-compat for OLD tier display:
    return tier === 'essential' ? 20 : tier === 'professional' ? 15 : 10
  })()
  // Slice 1 Commit 5 — perDriverDefault removed (field gone; no readers).

  const overrideValidation = validateFeatureOverrides(overridesText)

  const prefixRegex = /^[A-Z0-9_]{1,16}$/
  const prefixOk = prefixRegex.test(prefix)
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)
  const expiresOk = Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
  const numOk = (s: string) => s === '' || (!isNaN(Number(s)) && Number(s) >= 0)
  // lock_in_duration: optional; if present, integer in 1-36. CHECK constraint
  // at proposal_codes_lock_in_duration_valid (B66.2b commit 1) enforces the same.
  const lockInOk = lockInMonths === ''
    || (/^\d+$/.test(lockInMonths) && parseInt(lockInMonths, 10) >= 1 && parseInt(lockInMonths, 10) <= 36)
  // included_properties / included_drivers (B66.7): optional non-negative
  // integer. CHECKs proposal_codes_included_{properties,drivers}_valid mirror.
  const includedIntOk = (s: string) => s === '' || (/^\d+$/.test(s) && parseInt(s, 10) >= 0)
  const includedPropertiesOk = includedIntOk(includedProperties)
  // Slice 1 Commit 5 — customPerDriver + includedDrivers validation
  // removed (state declarations gone). customPerPermit added.
  const allOk = prefixOk && clientName.trim() && emailOk && expiresOk
    && numOk(customBaseFee) && numOk(customPerProperty)
    && numOk(customPerPermit)
    && lockInOk
    && includedPropertiesOk
    && overrideValidation.valid

  // B66.7 computed-total guard against fat-finger pricing. Sums what the
  // customer actually pays at month 1 given the chosen overrides +
  // included counts. Falls back to tier defaults when override blank.
  // Returns null when any input is non-numeric (UI suppresses display).
  //
  // Slice 1 Commit 5 — per-driver retired (perDrv always 0 since the
  // field is removed). Per-permit included in the total IF tier is
  // pm_only AND included_permits + customPerPermit both provide a
  // numeric rate. NOTE: this commit doesn't add an included_permits
  // input field — initial permit count is captured at customer
  // approval time (commit 4a's approve_vehicle hooks). The proposal-
  // code overhead total assumes 0 permits at issue (typical for a
  // new customer); permit total accrues as vehicles are approved.
  const computedMonthlyTotal = (() => {
    const base = customBaseFee === '' ? tierDefaults.base : Number(customBaseFee)
    const perProp = customPerProperty === '' ? perPropertyDefault : Number(customPerProperty)
    const propQty = includedProperties === '' ? 0 : parseInt(includedProperties, 10)
    if ([base, perProp, propQty].some(n => !Number.isFinite(n))) return null
    return base + perProp * propQty
  })()

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
      // Slice 1 Commit 5 — per_driver RETIRED in new model. Form
      // field removed; payload sends NULL always (kept in shape for
      // back-compat — the column still exists per the migration's
      // KEEP-for-back-compat decision).
      custom_per_driver_fee: null,
      // Slice 1 Commit 5 — NEW: per_permit override (PM-Only deals
      // only; legacy + enforcement_only get no permit billing per
      // Jose's locked decision so always NULL there).
      custom_per_permit_fee: (tierType === 'property_management' && tier === 'pm_only')
        ? (customPerPermit === '' ? null : Number(customPerPermit))
        : null,
      lock_in_duration: lockInMonths === '' ? null : parseInt(lockInMonths, 10),
      // B66.7 Option γ: PM track has no per_driver line, so included_drivers
      // is now always NULL (per_driver retired in slice 1 commit 5).
      included_properties: includedProperties === '' ? null : parseInt(includedProperties, 10),
      included_drivers: null,
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

          {/* Slice 1 Commit 5 — Custom Per-Driver Fee field REMOVED.
              per_driver line item retired in the new 3-tier model.
              Existing proposal_codes with non-null custom_per_driver_fee
              retain their value (back-compat); new proposals can't set it. */}

          {/* Slice 1 Commit 5 — Custom Per-Permit Fee field, PM-Only deals only.
              Single flat $/permit rate (NOT the graduated band editor —
              graduated is standard-catalog only; custom proposals get a
              flat negotiated rate per Jose's locked Legacy permit shape
              decision). Legacy + Enforcement-Only deals: NO permit
              field (unmetered / no permit billing). */}
          {tierType === 'property_management' && tier === 'pm_only' && (
            <>
              <label style={lbl}>Custom Per-Permit Fee ($/permit, flat)</label>
              <input type="number" step="0.01" min={0} value={customPerPermit}
                onChange={e => setCustomPerPermit(e.target.value)}
                placeholder="e.g. 1.50 (blank = use standard graduated rate)" style={inp} />
              <p style={{ color:'#666', fontSize:'10px', margin:'-10px 0 14px', fontStyle:'italic' }}>
                Single negotiated flat rate. Blank = customer pays the standard
                graduated PM-Only rate ($2.00 → $1.25 by volume).
                Stripe-side wiring of this override is deferred to a future
                commit; the value is captured here for now.
              </p>
            </>
          )}

          <label style={lbl}>Lock-in Duration (months, optional)</label>
          <input type="number" min={1} max={36} step={1} value={lockInMonths}
            onChange={e => setLockInMonths(e.target.value)}
            placeholder="Leave blank for no lock-in (range 1-36)" style={inp} />
          {!lockInOk && lockInMonths !== '' && (
            <p style={{ color: '#f44336', fontSize: '11px', margin: '-10px 0 14px' }}>Lock-in must be a whole number between 1 and 36 months.</p>
          )}

          <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '14px 0 6px' }}>
            Included Quantities (B66.7)
          </p>
          <p style={{ color: '#555', fontSize: '11px', margin: '0 0 10px' }}>
            Initial counts billed on the first Stripe invoice. Customer&apos;s rate (from above) applies uniformly to these AND to any future additions.
          </p>

          <label style={lbl}>Included Properties</label>
          <input type="number" min={0} step={1} value={includedProperties}
            onChange={e => setIncludedProperties(e.target.value)}
            placeholder="e.g. 30" style={inp} />
          {!includedPropertiesOk && includedProperties !== '' && (
            <p style={{ color: '#f44336', fontSize: '11px', margin: '-10px 0 14px' }}>Must be a non-negative whole number.</p>
          )}

          {/* Slice 1 Commit 5 — Included Drivers field REMOVED
              (per_driver retired in new model; included_drivers always
              NULL on new deals per the payload). */}

          {computedMonthlyTotal !== null && (
            <div style={{ background: '#1a2030', border: '1px solid #3a4055', borderRadius: '8px', padding: '12px 14px', margin: '0 0 14px' }}>
              <p style={{ color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
                Computed monthly total
              </p>
              <p style={{ color: '#C9A227', fontSize: '18px', fontWeight: 'bold', fontFamily: 'Courier New', margin: 0 }}>
                ${computedMonthlyTotal.toFixed(2)}/mo
              </p>
              <p style={{ color: '#666', fontSize: '11px', margin: '6px 0 0', fontFamily: 'Courier New' }}>
                base ${(customBaseFee === '' ? tierDefaults.base : Number(customBaseFee)).toFixed(2)}
                {' + '}
                {includedProperties || 0} prop × ${(customPerProperty === '' ? perPropertyDefault : Number(customPerProperty)).toFixed(2)}
              </p>
              {tierType === 'property_management' && tier === 'pm_only' && customPerPermit !== '' && (
                <p style={{ color: '#666', fontSize: '10px', margin: '4px 0 0', fontFamily: 'Courier New', fontStyle: 'italic' }}>
                  + permits × ${Number(customPerPermit).toFixed(2)} (flat, accrues as approved)
                </p>
              )}
            </div>
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

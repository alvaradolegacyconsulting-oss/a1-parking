'use client'
// B113 commit 2 — bulk upload UI for company_admin.
//
// Self-contained page at /company_admin/bulk-upload. Tier-gated at
// mount: if the caller's tier doesn't have bulk_upload=true (Starter
// or Essential today), shows an upgrade-nudge state. Otherwise:
//
//   1. Entity selector (Drivers | Residents) — entity-type drives
//      template + parser shape
//   2. Template download button — pulls the static template strings
//      from bulk-upload-helpers.ts (UTF-8 comment header included)
//   3. File picker — .csv via Papa Parse; .xlsx via xlsx + Papa Parse
//      (same pattern as super_admin bulk at admin/page.tsx)
//   4. Preview table with row-level validation errors inline
//   5. Submit button disabled until parse + validate succeed
//   6. Result UI on completion — success count + per-row error details
//
// All validation happens via the shared validateRows() helper. The
// server re-validates on POST; client validation is UX only.

import { useEffect, useState } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { supabase } from '../../supabase'
import { FEATURE_FLAGS } from '../../lib/feature-flags'
import { TIER_CONFIG, TierType } from '../../lib/tier-config'
import {
  validateRows,
  templateFor,
  MAX_UPLOAD_ROWS,
  type EntityType,
  type RowError,
} from '../../lib/bulk-upload-helpers'

const GOLD = '#C9A227'
const BG = '#0f1117'
const CARD_BG = '#161b26'
const BORDER = '#2a2f3d'
const TEXT = '#e2e8f0'
const MUTED = '#888'

interface TierContext {
  tier: string
  tier_type: TierType
  company: string
  has_bulk_upload: boolean
  pm_track: boolean
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'tier_gated'; tier: string }
  | { kind: 'unauthorized' }
  | { kind: 'ready'; ctx: TierContext }
  | { kind: 'error'; message: string }

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; total: number; successful: number; failed: number; results: Array<{ email: string; status: string; error?: string }> }
  | { kind: 'failed'; message: string; row_errors?: RowError[] }

export default function BulkUploadPage() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [entity, setEntity] = useState<EntityType>('driver')
  const [parsedRows, setParsedRows] = useState<Array<Record<string, unknown>>>([])
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [fileName, setFileName] = useState<string>('')
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })

  // ── Tier-gate on mount ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) {
        if (!cancelled) setLoad({ kind: 'unauthorized' })
        return
      }
      const { data: roleRow } = await supabase
        .from('user_roles')
        .select('role, company')
        .ilike('email', user.email)
        .single()
      if (!roleRow || roleRow.role !== 'company_admin' || !roleRow.company) {
        if (!cancelled) setLoad({ kind: 'unauthorized' })
        return
      }
      const { data: companyRow } = await supabase
        .from('companies')
        .select('tier, tier_type')
        .ilike('name', roleRow.company)
        .single()
      if (!companyRow) {
        if (!cancelled) setLoad({ kind: 'error', message: 'Company not found' })
        return
      }
      const tt = companyRow.tier_type as TierType
      const cfg = TIER_CONFIG[tt]?.[companyRow.tier]
      const hasFlag = cfg?.[FEATURE_FLAGS.BULK_UPLOAD] === true
      if (!hasFlag) {
        if (!cancelled) setLoad({ kind: 'tier_gated', tier: companyRow.tier })
        return
      }
      if (!cancelled) setLoad({
        kind: 'ready',
        ctx: { tier: companyRow.tier, tier_type: tt, company: roleRow.company, has_bulk_upload: true, pm_track: tt === 'property_management' },
      })
    })()
    return () => { cancelled = true }
  }, [])

  // ── Reset state on entity change ─────────────────────────────────
  useEffect(() => {
    setParsedRows([])
    setRowErrors([])
    setFileName('')
    setSubmit({ kind: 'idle' })
  }, [entity])

  // ── Template download ────────────────────────────────────────────
  function downloadTemplate() {
    const csv = templateFor(entity)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = entity === 'driver' ? 'driver_template.csv' : 'resident_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── File pick + parse ────────────────────────────────────────────
  async function handleFile(file: File) {
    setFileName(file.name)
    setSubmit({ kind: 'idle' })

    let rows: Array<Record<string, unknown>> = []
    if (/\.xlsx?$/i.test(file.name)) {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])
      const result = Papa.parse<Record<string, unknown>>(csv, {
        header: true,
        skipEmptyLines: true,
        comments: '#',
      })
      rows = result.data
    } else {
      const text = await file.text()
      const result = Papa.parse<Record<string, unknown>>(text, {
        header: true,
        skipEmptyLines: true,
        comments: '#',
      })
      rows = result.data
    }

    setParsedRows(rows)
    // Validate immediately for inline error display.
    const validated = validateRows(entity, rows)
    setRowErrors(validated.errors)
  }

  // ── Submit ────────────────────────────────────────────────────────
  async function submitUpload() {
    if (load.kind !== 'ready') return
    if (parsedRows.length === 0 || rowErrors.length > 0) return
    if (parsedRows.length > MAX_UPLOAD_ROWS) return
    setSubmit({ kind: 'submitting' })

    const res = await fetch('/api/billing/bulk-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity, rows: parsedRows }),
    })
    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
      setSubmit({ kind: 'failed', message: body.error || res.statusText, row_errors: body.row_errors })
      return
    }
    setSubmit({
      kind: 'done',
      total: body.total,
      successful: body.successful,
      failed: body.failed,
      results: body.results,
    })
  }

  // ── Render branches ──────────────────────────────────────────────
  if (load.kind === 'loading') {
    return <PageShell><Center>Loading…</Center></PageShell>
  }
  if (load.kind === 'unauthorized') {
    return <PageShell><Center>You don&apos;t have access to this page. <a href="/login" style={{ color: GOLD }}>Sign in</a></Center></PageShell>
  }
  if (load.kind === 'error') {
    return <PageShell><Center>{load.message}</Center></PageShell>
  }
  if (load.kind === 'tier_gated') {
    return (
      <PageShell>
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 28, textAlign: 'center' }}>
          <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>Bulk Upload — upgrade required</h2>
          <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 8px' }}>
            Your current tier is <strong>{load.tier}</strong>. Bulk upload is available on the higher tiers.
          </p>
          <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
            Contact support@shieldmylot.com to upgrade.
          </p>
          <a href="/company_admin" style={{ color: GOLD, fontSize: 13, textDecoration: 'none' }}>← Back to dashboard</a>
        </div>
      </PageShell>
    )
  }

  // ── load.kind === 'ready' ────────────────────────────────────────
  const ctx = load.ctx
  const entityOptions: Array<{ value: EntityType; label: string; disabled: boolean; disabledReason?: string }> = [
    { value: 'driver', label: 'Drivers', disabled: ctx.pm_track, disabledReason: 'Not available on Property Management track' },
    { value: 'resident', label: 'Residents', disabled: false },
  ]

  const submitDisabled = parsedRows.length === 0
    || rowErrors.length > 0
    || parsedRows.length > MAX_UPLOAD_ROWS
    || submit.kind === 'submitting'

  return (
    <PageShell>

      <div style={{ marginBottom: 18 }}>
        <a href="/company_admin" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>← Back to dashboard</a>
        <h1 style={{ color: GOLD, fontSize: 24, fontWeight: 800, margin: '8px 0 4px' }}>Bulk Upload</h1>
        <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
          {ctx.tier} tier · {ctx.company}
        </p>
      </div>

      {/* Entity selector */}
      <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 10 }}>1. Choose entity type</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {entityOptions.map(opt => (
            <button key={opt.value}
              onClick={() => !opt.disabled && setEntity(opt.value)}
              disabled={opt.disabled}
              title={opt.disabledReason}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 8,
                border: entity === opt.value ? `2px solid ${GOLD}` : `1px solid ${BORDER}`,
                background: opt.disabled ? '#1a1f2e' : (entity === opt.value ? 'rgba(201,162,39,0.10)' : 'transparent'),
                color: opt.disabled ? '#555' : (entity === opt.value ? GOLD : TEXT),
                fontWeight: 600, fontSize: 14, cursor: opt.disabled ? 'not-allowed' : 'pointer',
              }}>
              {opt.label}
              {opt.disabled && <div style={{ fontSize: 10, fontWeight: 400, marginTop: 4, color: '#555' }}>{opt.disabledReason}</div>}
            </button>
          ))}
        </div>
      </div>

      {/* Template download */}
      <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 10 }}>2. Download template</label>
        <p style={{ color: MUTED, fontSize: 12, margin: '0 0 12px', lineHeight: 1.5 }}>
          The template includes required + optional columns with example rows. Save as UTF-8 from Excel/Sheets/Numbers before uploading.
        </p>
        <button onClick={downloadTemplate}
          style={{ padding: '10px 16px', background: 'transparent', color: GOLD, border: `1px solid ${GOLD}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          Download {entity === 'driver' ? 'driver' : 'resident'} template (CSV)
        </button>
      </div>

      {/* File picker */}
      <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 10 }}>3. Upload file (.csv or .xlsx)</label>
        <input type="file" accept=".csv,.xlsx,.xls"
          onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
          style={{ color: TEXT, fontSize: 13 }} />
        {fileName && (
          <p style={{ color: MUTED, fontSize: 11, margin: '8px 0 0' }}>Selected: {fileName} · {parsedRows.length} rows parsed</p>
        )}
        {parsedRows.length > MAX_UPLOAD_ROWS && (
          <p style={{ color: '#f44336', fontSize: 12, margin: '8px 0 0' }}>
            Exceeds {MAX_UPLOAD_ROWS}-row limit. Split into smaller batches.
          </p>
        )}
      </div>

      {/* Preview / error list */}
      {parsedRows.length > 0 && (
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 10 }}>4. Preview &amp; validation</label>
          {rowErrors.length === 0 ? (
            <p style={{ color: '#86efac', fontSize: 13, margin: '0 0 10px' }}>
              ✓ {parsedRows.length} rows validated. Ready to submit.
            </p>
          ) : (
            <>
              <p style={{ color: '#f44336', fontSize: 13, margin: '0 0 10px' }}>
                {rowErrors.length} row error{rowErrors.length === 1 ? '' : 's'}. Fix in your CSV + re-upload.
              </p>
              <div style={{ maxHeight: 240, overflowY: 'auto', background: '#0f1117', border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6 }}>
                {rowErrors.slice(0, 50).map((err, i) => (
                  <div key={i} style={{ color: '#94a3b8', marginBottom: 4 }}>
                    Row {err.row_index + 2} · <span style={{ color: GOLD }}>{err.field}</span>: {err.message}
                  </div>
                ))}
                {rowErrors.length > 50 && (
                  <div style={{ color: MUTED, marginTop: 8 }}>… {rowErrors.length - 50} more errors not shown.</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Submit */}
      <div style={{ marginTop: 8, marginBottom: 24 }}>
        <button onClick={submitUpload} disabled={submitDisabled}
          style={{
            width: '100%', padding: 14, fontWeight: 'bold', fontSize: 15,
            background: submitDisabled ? '#1e2535' : GOLD,
            color: submitDisabled ? '#555' : '#0f1117',
            border: 'none', borderRadius: 10, cursor: submitDisabled ? 'not-allowed' : 'pointer',
          }}>
          {submit.kind === 'submitting' ? 'Inviting users + creating records…' : `Submit ${parsedRows.length || ''} ${entity === 'driver' ? 'drivers' : 'residents'}`}
        </button>
      </div>

      {/* Result UI */}
      {submit.kind === 'failed' && (
        <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <p style={{ color: '#f44336', fontSize: 13, fontWeight: 700, margin: '0 0 6px' }}>Upload failed</p>
          <p style={{ color: '#94a3b8', fontSize: 12, margin: 0 }}>{submit.message}</p>
          {submit.row_errors && submit.row_errors.length > 0 && (
            <ul style={{ color: '#94a3b8', fontSize: 11, margin: '8px 0 0', paddingLeft: 18 }}>
              {submit.row_errors.slice(0, 20).map((e, i) => (
                <li key={i}>Row {e.row_index + 2} · {e.field}: {e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {submit.kind === 'done' && (
        <div style={{ background: '#0d1f0d', border: '1px solid #2e7d32', borderRadius: 10, padding: 16 }}>
          <p style={{ color: '#86efac', fontSize: 14, fontWeight: 700, margin: '0 0 6px' }}>Upload complete</p>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 10px' }}>
            {submit.successful} of {submit.total} succeeded · {submit.failed} failed
          </p>
          <p style={{ color: MUTED, fontSize: 12, margin: '0 0 10px' }}>
            Each successful user has received an invite email + must set their password on first login.
          </p>
          {submit.failed > 0 && (
            <div style={{ background: '#0a0d14', border: `1px solid ${BORDER}`, borderRadius: 6, padding: 10, fontSize: 11 }}>
              <p style={{ color: GOLD, margin: '0 0 6px', fontWeight: 700 }}>Failed rows:</p>
              {submit.results.filter(r => r.status === 'error').slice(0, 50).map((r, i) => (
                <div key={i} style={{ color: '#94a3b8', marginBottom: 3 }}>
                  {r.email}: {r.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </PageShell>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'Arial, sans-serif', padding: '40px 24px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>{children}</div>
    </main>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 28, textAlign: 'center' }}>
      <p style={{ color: '#888', fontSize: 14, margin: 0 }}>{children}</p>
    </div>
  )
}

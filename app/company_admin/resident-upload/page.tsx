'use client'
// Phase A — resident onboarding upload, for company_admin.
//
// Distinct from /company_admin/bulk-upload (B113), which invites users
// immediately. This one submits a file for review: nothing is created
// until a ShieldMyLot admin approves the batch. The two must not be
// confused, so they are separate pages with separate words.
//
//   1. pick a property   — only the caller's own ACTIVE properties
//   2. download the template and the instructions
//   3. choose a file     — uploaded straight to the bulk-onboarding
//                          bucket, where RLS lets this CA write only
//                          {their property id}/{uuid}.csv
//   4. preview           — errors by spreadsheet row number, with a
//                          downloadable error file
//   5. attest            — name, title, and an explicit confirmation
//   6. submitted         — waiting for review
//
// 🔴 EVERY GATE HERE IS A RENDER, NOT A CONTROL. The flag, the role
// and the property list come from /api/bulk-onboarding/context, which
// runs the same authorizeBulkCompany() the upload and the submission
// run. The real enforcement is the storage policy and the two routes.
// Nothing on this page decides anything.

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../supabase'
import { BULK_CSV_HEADER } from '../../lib/bulk-onboarding'

const GOLD = '#C9A227'
const BG = '#0f1117'
const CARD_BG = '#161b26'
const BORDER = '#2a2f3d'
const TEXT = '#e2e8f0'
const MUTED = '#888'
const RED = '#e06c6c'
const GREEN = '#6cc48e'

interface Property { id: number; name: string }
interface Ctx { company: string; bucket: string; properties: Property[]; max_rows: number; max_bytes: number }
interface RowError { row: number; column: string; code: string; message: string }

interface PreviewResult {
  property: { id: number; name: string }
  data_rows: number
  rows_checked: number
  resident_count: number
  vehicle_count: number
  clean: boolean
  error_count: number
  errors: RowError[]
  errors_truncated: boolean
}

type Load =
  | { kind: 'loading' }
  | { kind: 'not_enabled'; message: string }
  | { kind: 'denied'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; ctx: Ctx }

type Stage =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'checking' }
  | { kind: 'previewed'; objectPath: string; fileName: string; result: PreviewResult }
  | { kind: 'submitting'; objectPath: string; fileName: string; result: PreviewResult }
  | { kind: 'submitted'; batchId: number; residents: number; vehicles: number; property: string; sha: string }
  | { kind: 'failed'; message: string }

// ── shells ──────────────────────────────────────────────────────────
// 🔴 MODULE SCOPE, NOT INSIDE THE COMPONENT. These were declared in
// ResidentUploadPage's body. A component declared inside a component is a
// NEW function on every render, so React sees a different element type at
// that position and unmounts the whole subtree instead of updating it.
// Every keystroke in "Your name" re-rendered the page, remounted the
// input, and the caret jumped out of the field. Nothing about the JSX
// looked wrong — the defect was the declaration site. They close over
// module constants only, so this is a plain move.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'Arial, sans-serif', padding: '40px 24px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <a href="/company_admin" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>← Back to dashboard</a>
        <h1 style={{ color: GOLD, fontSize: 24, fontWeight: 800, margin: '8px 0 4px' }}>Resident onboarding upload</h1>
        {children}
      </div>
    </main>
  )
}
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, marginTop: 16 }}>{children}</section>
  )
}

export default function ResidentUploadPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [propertyId, setPropertyId] = useState<number | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [attestName, setAttestName] = useState('')
  const [attestTitle, setAttestTitle] = useState('')
  const [attested, setAttested] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 🔴 One guard per fetch→setState pair. Without it a slow context
  // load can land after a fast one and overwrite it — the last-write
  // -wins race that has produced blank portals here before.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/bulk-onboarding/context', { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        if (r.ok && j.ok) { setLoad({ kind: 'ready', ctx: j as Ctx }); return }
        if (j.error === 'bulk_onboarding_not_enabled') { setLoad({ kind: 'not_enabled', message: j.message }); return }
        if (r.status === 401 || r.status === 403) { setLoad({ kind: 'denied', message: j.message || 'You do not have access to this page.' }); return }
        setLoad({ kind: 'error', message: j.message || 'Something went wrong loading this page. Please try again.' })
      } catch {
        if (!cancelled) setLoad({ kind: 'error', message: 'We could not reach the server. Check your connection and try again.' })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const reset = useCallback(() => {
    setStage({ kind: 'idle' }); setAttested(false)
    if (fileRef.current) fileRef.current.value = ''
  }, [])

  // Changing the property invalidates a preview: it was checked against
  // the old property's plates and residents.
  useEffect(() => { reset() }, [propertyId, reset])

  function downloadTemplate() {
    // Built from the shared constant, so the file a customer fills in
    // cannot have a different header from the one the route demands.
    const csv = `${BULK_CSV_HEADER}\n101,Jane,Doe,jane.doe@example.com,,ABC1234,TX,Toyota,Camry,Silver,\n`
    download(csv, 'resident_upload_template.csv')
  }

  function downloadErrors(result: PreviewResult, fileName: string) {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    const csv = ['row,column,problem',
      ...result.errors.map(e => `${e.row},${esc(e.column)},${esc(e.message)}`)].join('\n') + '\n'
    download(csv, fileName.replace(/\.csv$/i, '') + '_errors.csv')
  }

  function download(text: string, name: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleFile(file: File) {
    if (propertyId === null) return
    if (file.size > (load.kind === 'ready' ? load.ctx.max_bytes : 0)) {
      setStage({ kind: 'failed', message: `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 2 MB.` })
      return
    }
    setAttested(false)
    setStage({ kind: 'uploading' })

    // The path the storage policy allows: this property's prefix, a
    // fresh uuid, .csv. The server does not trust it — it re-derives
    // the property from it and checks the company — but sending a path
    // the policy would refuse just produces a confusing error.
    const objectPath = `${propertyId}/${crypto.randomUUID()}.csv`
    const up = await supabase.storage.from('bulk-onboarding')
      .upload(objectPath, file, { contentType: file.type || 'text/csv', upsert: false })
    if (up.error) {
      // Raw storage errors never reach the user.
      console.error('[resident-upload] upload:', up.error)
      setStage({ kind: 'failed', message: 'We could not accept that file. Make sure it is a .csv saved from the template, then try again.' })
      return
    }

    setStage({ kind: 'checking' })
    try {
      const r = await fetch('/api/bulk-onboarding/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object_path: objectPath }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setStage({ kind: 'failed', message: j.message || 'We could not check that file. Please try again.' }); return }
      setStage({ kind: 'previewed', objectPath, fileName: file.name, result: j as PreviewResult })
    } catch {
      setStage({ kind: 'failed', message: 'We could not reach the server. Check your connection and try again.' })
    }
  }

  async function submitBatch() {
    if (stage.kind !== 'previewed') return
    const { objectPath, fileName, result } = stage
    setStage({ kind: 'submitting', objectPath, fileName, result })
    try {
      const r = await fetch('/api/bulk-onboarding/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object_path: objectPath, source_filename: fileName,
          attested_name: attestName.trim(), attested_title: attestTitle.trim(),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) {
        setStage({ kind: 'failed', message: j.message || 'We could not submit that file. Please try again.' })
        return
      }
      setStage({ kind: 'submitted', batchId: j.batch_id, residents: j.resident_count,
                 vehicles: j.vehicle_count, property: j.property?.name ?? '', sha: String(j.file_sha256).slice(0, 12) })
    } catch {
      setStage({ kind: 'failed', message: 'We could not reach the server. Check your connection and try again.' })
    }
  }

  if (load.kind === 'loading') return <Shell><Card><p style={{ color: MUTED, margin: 0 }}>Loading…</p></Card></Shell>
  if (load.kind === 'not_enabled') return (
    <Shell><Card>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Not switched on for your account</h2>
      <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>{load.message}</p>
    </Card></Shell>
  )
  if (load.kind === 'denied' || load.kind === 'error') return (
    <Shell><Card><p style={{ color: load.kind === 'denied' ? MUTED : RED, fontSize: 14, margin: 0 }}>{load.message}</p></Card></Shell>
  )

  const ctx = load.ctx

  // 🔴 EMPTY STATE. A CA with no properties yet must be told what to do
  // next, not shown an empty dropdown. Properties are created through
  // the normal flow; this page never creates one.
  if (ctx.properties.length === 0) return (
    <Shell><Card>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>No properties yet</h2>
      <p style={{ color: MUTED, fontSize: 14, margin: '0 0 12px', lineHeight: 1.6 }}>
        A resident upload goes to one property, so there has to be a property first.
        Add the property from your dashboard, then come back and upload.
      </p>
      <a href="/company_admin" style={{ color: GOLD, fontSize: 13 }}>Add the property first, then upload →</a>
    </Card></Shell>
  )

  const previewed = stage.kind === 'previewed' ? stage.result : null
  const canSubmit = previewed !== null && previewed.clean
    && attestName.trim() !== '' && attestTitle.trim() !== '' && attested

  // 🔴 Say WHY the button is off. A disabled Submit with no reason next
  // to it is the single most common way a multi-step form dead-ends.
  const blockers: string[] = []
  if (!previewed) blockers.push('choose a file and let us check it')
  else if (!previewed.clean) blockers.push(`fix the ${previewed.error_count} ${previewed.error_count === 1 ? 'problem' : 'problems'} below and upload again`)
  if (previewed?.clean && attestName.trim() === '') blockers.push('enter your name')
  if (previewed?.clean && attestTitle.trim() === '') blockers.push('enter your title')
  if (previewed?.clean && !attested) blockers.push('tick the confirmation')

  return (
    <Shell>
      <p style={{ color: MUTED, fontSize: 13, margin: '0 0 4px' }}>
        {ctx.company} · one property per file · up to {ctx.max_rows.toLocaleString('en-US')} rows
      </p>
      <p style={{ color: MUTED, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
        Nothing is created when you submit. We check the file and a ShieldMyLot
        administrator releases it. You are responsible for the accuracy of the data
        and for having the property&apos;s authorization to submit it.
      </p>

      {/* ── 1. property ───────────────────────────────────────────── */}
      <Card>
        <label htmlFor="prop" style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>1. Which property?</label>
        <select
          id="prop"
          value={propertyId ?? ''}
          onChange={e => setPropertyId(e.target.value === '' ? null : Number(e.target.value))}
          style={{ width: '100%', padding: '10px 12px', background: BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 14 }}
        >
          <option value="">Choose a property…</option>
          {ctx.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Card>

      {/* ── 2. template ───────────────────────────────────────────── */}
      <Card>
        <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>2. Fill in the template</p>
        <p style={{ color: MUTED, fontSize: 13, margin: '0 0 12px', lineHeight: 1.6 }}>
          One row per vehicle. A resident with three cars gets three rows with the same
          unit and the same email. Save as CSV (UTF-8).
        </p>
        <button onClick={downloadTemplate} style={btn()}>Download the template</button>
      </Card>

      {/* ── 3. file ───────────────────────────────────────────────── */}
      <Card>
        <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>3. Upload your file</p>
        <input
          ref={fileRef} type="file" accept=".csv,text/csv"
          disabled={propertyId === null || stage.kind === 'uploading' || stage.kind === 'checking' || stage.kind === 'submitting'}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          style={{ fontSize: 13, color: TEXT }}
        />
        {propertyId === null && <p style={{ color: MUTED, fontSize: 12, margin: '8px 0 0' }}>Choose a property first.</p>}
        {stage.kind === 'uploading' && <p style={{ color: MUTED, fontSize: 13, margin: '10px 0 0' }}>Uploading…</p>}
        {stage.kind === 'checking' && <p style={{ color: MUTED, fontSize: 13, margin: '10px 0 0' }}>Checking your file against this property&apos;s records…</p>}
        {stage.kind === 'failed' && (
          <p style={{ color: RED, fontSize: 13, margin: '10px 0 0', lineHeight: 1.6 }}>
            {stage.message} <button onClick={reset} style={{ ...btn(), padding: '4px 10px', marginLeft: 8 }}>Start over</button>
          </p>
        )}
      </Card>

      {/* ── 4. the result ─────────────────────────────────────────── */}
      {previewed && (
        <Card>
          <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px' }}>4. What we found</p>
          <p style={{ fontSize: 14, margin: '0 0 10px' }}>
            {previewed.data_rows.toLocaleString('en-US')} rows ·{' '}
            {previewed.resident_count.toLocaleString('en-US')} residents ·{' '}
            {previewed.vehicle_count.toLocaleString('en-US')} vehicles · {previewed.property.name}
          </p>
          {previewed.clean ? (
            <p style={{ color: GREEN, fontSize: 14, margin: 0 }}>No problems found. Confirm below to submit it for review.</p>
          ) : (
            <>
              <p style={{ color: RED, fontSize: 14, margin: '0 0 10px' }}>
                {previewed.error_count.toLocaleString('en-US')} {previewed.error_count === 1 ? 'problem' : 'problems'} to fix.
                Row numbers match your spreadsheet — the header is row 1.
              </p>
              <button onClick={() => downloadErrors(previewed, stage.kind === 'previewed' ? stage.fileName : 'upload')} style={btn()}>
                Download the list
              </button>
              {previewed.errors_truncated && (
                <p style={{ color: MUTED, fontSize: 12, margin: '8px 0 0' }}>
                  Showing the first {previewed.errors.length} of {previewed.error_count}. The downloaded list is complete.
                </p>
              )}
              <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: BG }}>
                      <th style={th()}>Row</th><th style={th()}>Column</th><th style={th()}>What to fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewed.errors.map((e, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${BORDER}` }}>
                        <td style={td()}>{e.row}</td>
                        <td style={{ ...td(), color: MUTED }}>{e.column}</td>
                        <td style={td()}>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── 5. attestation ───────────────────────────────────────── */}
      {previewed?.clean && (
        <Card>
          <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px' }}>5. Confirm and submit</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <input placeholder="Your name" value={attestName} onChange={e => setAttestName(e.target.value)}
                   style={{ flex: '1 1 220px', padding: '10px 12px', background: BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 14 }} />
            <input placeholder="Your title" value={attestTitle} onChange={e => setAttestTitle(e.target.value)}
                   style={{ flex: '1 1 220px', padding: '10px 12px', background: BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 14 }} />
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.6, cursor: 'pointer' }}>
            <input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              I confirm this data is accurate and that I am authorized by {previewed.property.name} to
              submit it for parking enforcement.
            </span>
          </label>

          <div style={{ marginTop: 14 }}>
            <button onClick={submitBatch} disabled={!canSubmit || stage.kind === 'submitting'}
                    style={{ ...btn(), opacity: canSubmit && stage.kind !== 'submitting' ? 1 : 0.45, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
              {stage.kind === 'submitting' ? 'Submitting…' : 'Submit for review'}
            </button>
            {!canSubmit && blockers.length > 0 && (
              <p style={{ color: MUTED, fontSize: 12, margin: '8px 0 0' }}>To submit: {blockers.join(', then ')}.</p>
            )}
          </div>
        </Card>
      )}

      {/* ── 6. submitted ─────────────────────────────────────────── */}
      {stage.kind === 'submitted' && (
        <Card>
          <h2 style={{ color: GREEN, fontSize: 16, margin: '0 0 8px' }}>Submitted for review</h2>
          <p style={{ fontSize: 14, margin: '0 0 8px', lineHeight: 1.6 }}>
            Batch #{stage.batchId} · {stage.residents.toLocaleString('en-US')} residents ·{' '}
            {stage.vehicles.toLocaleString('en-US')} vehicles · {stage.property}
          </p>
          <p style={{ color: MUTED, fontSize: 13, margin: '0 0 12px', lineHeight: 1.6 }}>
            Nothing has been created yet. A ShieldMyLot administrator reviews the batch
            and releases it; we will be in touch if anything needs changing. Your file is
            stored as submitted and cannot be altered — reference {stage.sha}.
          </p>
          <button onClick={() => { reset(); setAttestName(''); setAttestTitle('') }} style={btn()}>Upload another file</button>
        </Card>
      )}

      {/* The blocker line also has to be reachable BEFORE a clean
          preview exists, or the page looks inert while the file is
          still the problem. */}
      {!previewed && stage.kind === 'idle' && propertyId !== null && (
        <p style={{ color: MUTED, fontSize: 12, marginTop: 14 }}>To submit: {blockers.join(', then ')}.</p>
      )}
    </Shell>
  )
}

const btn = (): React.CSSProperties => ({
  background: GOLD, color: '#1a1a1a', border: 'none', borderRadius: 6,
  padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
})
const th = (): React.CSSProperties => ({ textAlign: 'left', padding: '8px 10px', color: MUTED, fontWeight: 700 })
const td = (): React.CSSProperties => ({ padding: '8px 10px', verticalAlign: 'top', lineHeight: 1.5 })

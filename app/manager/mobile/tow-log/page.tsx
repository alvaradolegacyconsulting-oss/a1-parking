// ════════════════════════════════════════════════════════════════════
// /manager/mobile/tow-log — the create surface for the tow log.
//
// One job: a property manager standing next to a car at 11pm records
// that it was removed, in as few taps as the record allows. Reading,
// filtering and voiding are the desktop tab (Commit 6); what that tab
// can show is decided by what this screen captures.
//
// ── BOUNDARY (DECISION_tow_log_is_a_log_sept9_2026) ─────────────────
// This is a LOG, not enforcement tooling. It must never grow: storage
// location, fees or charges, a resident- or owner-facing view, or
// language positioning a record as evidence or compliance. Each of
// those looks reasonable on its own — that is exactly how the boundary
// erodes. `notes` is INTERNAL, manager-only, and says what happened;
// `reason_notes` says why, and is required when the reason is Other.
//
// ── GATES ───────────────────────────────────────────────────────────
//   Role  — manager + admin only. Leasing agents are excluded per the
//           Sept 7 ruling; this is the same shape as /manager/mobile
//           (feedback_leasing_agent_write_expansion_trap: a convenience
//           surface is not a place to widen who can write).
//   Tier  — pm_starter + pm_only ONLY, via tierCanSeeTowLog(). The RPCs
//           accept `legacy` as well. That divergence is DELIBERATE and
//           documented at the top of app/lib/tow-log-writes.ts. Do not
//           "fix" the mismatch in either direction on sight.
//   Admin — bypasses the tier gate, mirroring the super-admin bypass
//           in the RPCs (v_caller_role <> 'admin' AND NOT
//           my_tier_pm_capable()).
//
// ── FIELD ORDER IS THE DESIGN ───────────────────────────────────────
// Plate, reason, who removed it, when, who authorized it, notes,
// photos. The required path reads straight down; everything optional
// is below everything required. Property is FIXED from the manager's
// assignment and shown in the header — never a picker mid-form.
//
// All writes go through app/lib/tow-log-writes.ts. No RPC is called
// from this file.
// ════════════════════════════════════════════════════════════════════
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../../supabase'
import { getCompanyContext } from '../../../lib/tier'
import { normalizePlate } from '../../../lib/plate'
import {
  REMOVAL_REASONS,
  OTHER_NOTE_MIN_LENGTH,
  tierCanSeeTowLog,
  listTowOperators,
  createTowOperator,
  recordVehicleRemoval,
  uploadRemovalMedia,
  type TowOperator,
  type MediaUploadOutcome,
} from '../../../lib/tow-log-writes'

const C = {
  bg: '#0f1117',
  panel: '#1e2535',
  border: '#3a4055',
  gold: '#C9A227',
  green: '#4caf50',
  greenDark: '#1a3a1a',
  greenBorder: '#2e7d32',
  red: '#f44336',
  redDark: '#3a1a1a',
  redBorder: '#b71c1c',
  text: '#e8e8e8',
  muted: '#888',
  faint: '#666',
}

type PropertyOption = { id: number; name: string; company: string | null }
type GateStatus = 'checking' | 'ready' | 'unauthorized' | 'tier_locked' | 'no_property' | 'error'

// datetime-local speaks LOCAL wall-clock with no zone. Both helpers stay
// in local time and the Date is only converted to UTC at the RPC
// boundary, so "11:40pm" means 11:40pm where the manager is standing.
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInputValue(v: string): Date {
  return new Date(v)   // no trailing Z — parsed as local
}

export default function TowLogMobilePage() {
  const [gateStatus, setGateStatus] = useState<GateStatus>('checking')
  const [gateMessage, setGateMessage] = useState<string>('')
  const [callerEmail, setCallerEmail] = useState<string>('')
  const [propertyOptions, setPropertyOptions] = useState<PropertyOption[]>([])
  const [propertyName, setPropertyName] = useState<string>('')

  // ── Form ──────────────────────────────────────────────────────────
  const [plate, setPlate] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [reasonNotes, setReasonNotes] = useState('')
  const [operators, setOperators] = useState<TowOperator[]>([])
  const [operatorId, setOperatorId] = useState<string>('')
  const [newOperatorMode, setNewOperatorMode] = useState(false)
  const [newOperatorName, setNewOperatorName] = useState('')
  const [newOperatorPhone, setNewOperatorPhone] = useState('')
  const [newOperatorTdlr, setNewOperatorTdlr] = useState('')
  const [operatorNotice, setOperatorNotice] = useState<string | null>(null)
  const [operatorBusy, setOperatorBusy] = useState(false)
  const [timeIsNow, setTimeIsNow] = useState(true)
  const [towedAtLocal, setTowedAtLocal] = useState<string>(toLocalInputValue(new Date()))
  const [authorizedByEmail, setAuthorizedByEmail] = useState('')
  const [authorizedByName, setAuthorizedByName] = useState('')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<File[]>([])

  // ── Submit ────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ id: number; plate: string; media: MediaUploadOutcome | null } | null>(null)

  const selectedProperty = propertyOptions.find(p => p.name === propertyName) ?? null
  const reasonIsOther = reasonCode === 'other'
  const reasonNotesShort = reasonIsOther && reasonNotes.trim().length < OTHER_NOTE_MIN_LENGTH

  // ── Gate + bootstrap ──────────────────────────────────────────────
  useEffect(() => {
    async function bootstrap() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) { setGateStatus('unauthorized'); return }
      setCallerEmail(user.email)
      setAuthorizedByEmail(user.email)   // prefilled, editable — see field 5

      const { data: role, error: roleErr } = await supabase.rpc('get_my_role')
      if (roleErr) {
        console.error('[Tow log] get_my_role failed', roleErr)
        setGateStatus('error'); setGateMessage('Could not verify your role. Try again in a moment.')
        return
      }
      if (role !== 'manager' && role !== 'admin') { setGateStatus('unauthorized'); return }

      // Tier gate — narrower than the RPC gate on purpose. Admin
      // bypasses, mirroring the RPCs' super-admin branch.
      const tier = getCompanyContext().tier || ''
      if (role !== 'admin' && !tierCanSeeTowLog(String(tier))) {
        setGateStatus('tier_locked'); return
      }

      const { data: props, error: propsErr } = await supabase.rpc('get_my_properties')
      if (propsErr) {
        console.error('[Tow log] get_my_properties failed', propsErr)
        setGateStatus('error'); setGateMessage('Could not load your properties. Try again in a moment.')
        return
      }
      const propList: string[] = Array.isArray(props) ? props.filter(Boolean) : []
      if (propList.length === 0) { setGateStatus('no_property'); return }

      // id is required — it is the first segment of every media storage
      // path, and attach_removal_media recomputes and validates that
      // prefix. Without it photos cannot be attached at all.
      const { data: propRows, error: propRowsErr } = await supabase
        .from('properties')
        .select('id, name, company')
        .in('name', propList)
        .order('name')
      if (propRowsErr) console.error('[Tow log] properties row fetch failed', propRowsErr)
      const options = (propRows ?? []).map(p => ({ id: Number(p.id), name: p.name, company: p.company ?? null }))
      if (options.length === 0) { setGateStatus('no_property'); return }
      setPropertyOptions(options)
      setPropertyName(options[0].name)

      setOperators(await listTowOperators(supabase))
      setGateStatus('ready')
    }
    bootstrap()
  }, [])

  // ── Add an operator inline ────────────────────────────────────────
  // find-or-create: a repeated name returns the EXISTING id with
  // created:false. Say so plainly — a manager who typed a name and got
  // a different outcome than they expected deserves to be told which
  // one they are now attached to.
  async function handleAddOperator() {
    setOperatorNotice(null); setFormError(null)
    const name = newOperatorName.trim()
    if (!name) { setFormError('Enter the tow operator name.'); return }
    setOperatorBusy(true)
    const result = await createTowOperator(supabase, {
      name, phone: newOperatorPhone, tdlr: newOperatorTdlr,
    })
    setOperatorBusy(false)
    if (!result.ok) { setFormError(result.message); return }

    const refreshed = await listTowOperators(supabase)
    setOperators(refreshed)
    setOperatorId(String(result.id))
    setOperatorNotice(
      result.created
        ? `Added ${name}. It will be in the list next time.`
        : `Using your saved ${refreshed.find(o => o.id === result.id)?.name ?? name} — no duplicate was created.`,
    )
    setNewOperatorMode(false)
    setNewOperatorName(''); setNewOperatorPhone(''); setNewOperatorTdlr('')
  }

  function resetForm() {
    setPlate(''); setReasonCode(''); setReasonNotes('')
    setTimeIsNow(true); setTowedAtLocal(toLocalInputValue(new Date()))
    setAuthorizedByEmail(callerEmail); setAuthorizedByName('')
    setNotes(''); setFiles([])
    setFormError(null); setOperatorNotice(null)
  }

  // ── Submit ────────────────────────────────────────────────────────
  // Sequence is row → upload → attach, and it is load-bearing: the
  // removal id is half the storage path. A photo failure never fails
  // the record — the record is the thing that matters.
  async function handleSubmit() {
    setFormError(null); setSuccess(null)
    if (!selectedProperty) { setFormError('No property selected.'); return }

    setSubmitting(true)
    const towedAt = timeIsNow ? new Date() : fromLocalInputValue(towedAtLocal)
    const result = await recordVehicleRemoval(supabase, {
      property: selectedProperty.name,
      plate,
      reasonCode,
      towedAt,
      authorizedByEmail,
      towOperatorId: Number(operatorId),
      authorizedByName: authorizedByName || null,
      reasonNotes: reasonNotes || null,
      notes: notes || null,
    })

    if (!result.ok) {
      setSubmitting(false)
      setFormError(result.message)
      return
    }

    let media: MediaUploadOutcome | null = null
    if (files.length > 0) {
      setUploadProgress({ done: 0, total: files.length })
      media = await uploadRemovalMedia(supabase, {
        propertyId: selectedProperty.id,
        removalId: result.id,
        files,
        onProgress: (done, total) => setUploadProgress({ done, total }),
      })
      setUploadProgress(null)
    }

    setSubmitting(false)
    setSuccess({ id: result.id, plate: normalizePlate(plate), media })
    resetForm()
  }

  const canSubmit =
    !submitting &&
    normalizePlate(plate).length > 0 &&
    reasonCode.length > 0 &&
    !reasonNotesShort &&
    operatorId.length > 0 &&
    authorizedByEmail.trim().length > 0

  // ── Gate render ───────────────────────────────────────────────────
  if (gateStatus === 'checking') {
    return <Shell><p style={{ color: C.muted, textAlign: 'center', marginTop: '40px' }}>Loading…</p></Shell>
  }
  if (gateStatus === 'unauthorized') {
    return (
      <Shell>
        <Message color={C.red}>You don&apos;t have access to this page.</Message>
        <a href="/login" style={{ color: C.gold, fontSize: '13px', display: 'block', textAlign: 'center', marginTop: '16px' }}>← Login</a>
      </Shell>
    )
  }
  if (gateStatus === 'tier_locked') {
    return (
      <Shell>
        <Message color={C.muted}>The tow log is not included in your current plan.</Message>
        <a href="/manager/mobile" style={{ color: C.gold, fontSize: '13px', display: 'block', textAlign: 'center', marginTop: '16px' }}>← Back</a>
      </Shell>
    )
  }
  if (gateStatus === 'no_property') {
    return <Shell><Message color={C.red}>No property assigned to your role. Contact your administrator.</Message></Shell>
  }
  if (gateStatus === 'error') {
    return <Shell><Message color={C.red}>{gateMessage}</Message></Shell>
  }

  // ── Success render ────────────────────────────────────────────────
  if (success) {
    const failures = success.media?.failures ?? []
    return (
      <Shell>
        <div style={{ background: C.greenDark, border: `1px solid ${C.greenBorder}`, borderRadius: '10px', padding: '16px', marginTop: '20px' }}>
          <div style={{ color: C.green, fontSize: '16px', fontWeight: 'bold', marginBottom: '6px' }}>Removal recorded</div>
          <div style={{ color: C.text, fontSize: '14px', fontFamily: 'Courier New, monospace', letterSpacing: '0.08em' }}>{success.plate}</div>
          <div style={{ color: C.muted, fontSize: '12px', marginTop: '8px' }}>Record #{success.id} · {propertyName}</div>
          {success.media && (
            <div style={{ color: success.media.attached > 0 ? C.muted : C.gold, fontSize: '12px', marginTop: '8px' }}>
              {success.media.attached} photo{success.media.attached === 1 ? '' : 's'} attached
              {failures.length > 0 && ` · ${failures.length} could not be attached`}
            </div>
          )}
          {failures.length > 0 && (
            <div style={{ marginTop: '8px' }}>
              {failures.map((f, i) => (
                <div key={i} style={{ color: C.gold, fontSize: '11px', lineHeight: 1.5 }}>{f.fileName}: {f.message}</div>
              ))}
              <div style={{ color: C.muted, fontSize: '11px', marginTop: '4px' }}>The record itself is saved.</div>
            </div>
          )}
        </div>
        <button onClick={() => setSuccess(null)} style={btn(C.gold, true)}>Log another removal</button>
        <a href="/manager/mobile" style={{ color: C.gold, fontSize: '13px', display: 'block', textAlign: 'center', marginTop: '14px' }}>← Back to approvals</a>
      </Shell>
    )
  }

  // ── Main render ───────────────────────────────────────────────────
  return (
    <Shell>
      {/* Property is FIXED — header, not a picker. */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ color: C.gold, fontSize: '18px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{propertyName}</div>
        <div style={{ color: C.muted, fontSize: '11px' }}>Record a vehicle removal</div>
      </div>

      {propertyOptions.length > 1 && (
        <select value={propertyName} onChange={e => setPropertyName(e.target.value)} style={input()}>
          {propertyOptions.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
      )}

      {/* 1 — Plate */}
      <Field label="License plate" required>
        <input
          value={plate}
          onChange={e => setPlate(normalizePlate(e.target.value))}
          placeholder="ABC1234"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          style={{
            ...input(),
            fontFamily: 'Courier New, monospace',
            fontSize: '26px',
            letterSpacing: '0.12em',
            textAlign: 'center',
            fontWeight: 'bold',
          }}
        />
      </Field>

      {/* 2 — Reason */}
      <Field label="Reason" required>
        <select value={reasonCode} onChange={e => setReasonCode(e.target.value)} style={input()}>
          <option value="">Select a reason…</option>
          {REMOVAL_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
        {reasonIsOther && (
          <>
            <textarea
              value={reasonNotes}
              onChange={e => setReasonNotes(e.target.value)}
              placeholder="Describe why the vehicle was removed"
              rows={3}
              style={{ ...input(), marginTop: '8px', resize: 'vertical' }}
            />
            <div style={{ color: reasonNotesShort ? C.gold : C.muted, fontSize: '11px' }}>
              {reasonNotes.trim().length}/{OTHER_NOTE_MIN_LENGTH} characters{reasonNotesShort ? '' : ' — OK'}
            </div>
          </>
        )}
      </Field>

      {/* 3 — Towed by */}
      <Field label="Removed by" required>
        {!newOperatorMode && (
          <select
            value={operatorId}
            onChange={e => {
              if (e.target.value === '__new__') { setNewOperatorMode(true); setOperatorId(''); return }
              setOperatorId(e.target.value); setOperatorNotice(null)
            }}
            style={input()}
          >
            <option value="">Select an operator…</option>
            {operators.map(o => <option key={o.id} value={String(o.id)}>{o.name}{o.phone ? ` · ${o.phone}` : ''}</option>)}
            <option value="__new__">+ Someone else…</option>
          </select>
        )}
        {newOperatorMode && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px' }}>
            <input value={newOperatorName} onChange={e => setNewOperatorName(e.target.value)} placeholder="Company name" style={input()} />
            <input value={newOperatorPhone} onChange={e => setNewOperatorPhone(e.target.value)} placeholder="Phone (optional)" inputMode="tel" style={input()} />
            <input value={newOperatorTdlr} onChange={e => setNewOperatorTdlr(e.target.value)} placeholder="TDLR licence number (optional)" style={input()} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleAddOperator} disabled={operatorBusy} style={{ ...btn(C.gold, true), flex: 1, marginTop: 0 }}>
                {operatorBusy ? 'Saving…' : 'Save operator'}
              </button>
              <button onClick={() => { setNewOperatorMode(false); setNewOperatorName('') }} style={{ ...btn(C.muted, false), flex: 1, marginTop: 0 }}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {operatorNotice && <div style={{ color: C.green, fontSize: '12px', marginTop: '6px' }}>{operatorNotice}</div>}
      </Field>

      {/* 4 — When. Zero taps live, one for the Monday write-up. Without
          the Change link every backdated record silently carries the
          wrong timestamp. */}
      <Field label="When" required>
        {timeIsNow ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ color: C.text, fontSize: '15px' }}>Just now</div>
            <button onClick={() => { setTimeIsNow(false); setTowedAtLocal(toLocalInputValue(new Date())) }}
              style={{ background: 'none', border: 'none', color: C.gold, fontSize: '13px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
              Change
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input type="datetime-local" value={towedAtLocal} onChange={e => setTowedAtLocal(e.target.value)} style={{ ...input(), marginBottom: 0 }} />
            <button onClick={() => setTimeIsNow(true)}
              style={{ background: 'none', border: 'none', color: C.gold, fontSize: '13px', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}>
              Now
            </button>
          </div>
        )}
      </Field>

      {/* 5 — Authorized by. A statement of fact about who made the call,
          NOT validated against user_roles: a courtesy officer, an owner
          or an after-hours contact can authorize without an account. */}
      <Field label="Authorized by" required>
        <input value={authorizedByEmail} onChange={e => setAuthorizedByEmail(e.target.value)} placeholder="email" inputMode="email" autoCapitalize="none" style={input()} />
        <input value={authorizedByName} onChange={e => setAuthorizedByName(e.target.value)} placeholder="Name (optional — if they have no account)" style={input()} />
      </Field>

      {/* 6 — Notes. INTERNAL. Never shown to a resident or vehicle owner. */}
      <Field label="Notes (internal)">
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="What happened. Only your team sees this."
          rows={3}
          style={{ ...input(), resize: 'vertical' }}
        />
      </Field>

      {/* 7 — Photos, optional, last. */}
      <Field label="Photos (optional)">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          multiple
          onChange={e => setFiles(Array.from(e.target.files ?? []))}
          style={{ ...input(), padding: '8px' }}
        />
        {files.length > 0 && (
          <div style={{ color: C.muted, fontSize: '11px' }}>
            {files.length} file{files.length === 1 ? '' : 's'} selected · resized before upload
          </div>
        )}
      </Field>

      {formError && (
        <div style={{ background: C.redDark, border: `1px solid ${C.redBorder}`, borderRadius: '8px', padding: '10px', color: C.text, fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
          {formError}
        </div>
      )}

      {uploadProgress && (
        <div style={{ color: C.muted, fontSize: '12px', marginBottom: '8px', textAlign: 'center' }}>
          Uploading photo {Math.min(uploadProgress.done + 1, uploadProgress.total)} of {uploadProgress.total}…
        </div>
      )}

      <button onClick={handleSubmit} disabled={!canSubmit} style={btn(C.gold, canSubmit)}>
        {submitting ? 'Saving…' : 'Record removal'}
      </button>

      {/* Why Submit is disabled — never leave the manager guessing. */}
      {!canSubmit && !submitting && (
        <div style={{ color: C.muted, fontSize: '11px', textAlign: 'center', marginTop: '8px', lineHeight: 1.5 }}>
          Still needed: {[
            normalizePlate(plate).length === 0 && 'plate',
            reasonCode.length === 0 && 'reason',
            reasonNotesShort && `reason description (${OTHER_NOTE_MIN_LENGTH}+ characters)`,
            operatorId.length === 0 && 'who removed it',
            authorizedByEmail.trim().length === 0 && 'who authorized it',
          ].filter(Boolean).join(', ')}
        </div>
      )}

      <a href="/manager/mobile" style={{ color: C.gold, fontSize: '13px', display: 'block', textAlign: 'center', marginTop: '18px' }}>← Back to approvals</a>
    </Shell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Presentational helpers — same shell and palette as /manager/mobile
// ════════════════════════════════════════════════════════════════════

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Arial, sans-serif', padding: '14px', color: C.text }}>
      <div style={{ maxWidth: '540px', margin: '0 auto' }}>{children}</div>
    </main>
  )
}

function Message({ children, color }: { children: React.ReactNode; color: string }) {
  return <p style={{ color, textAlign: 'center', marginTop: '40px', fontSize: '14px', lineHeight: 1.5 }}>{children}</p>
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label style={{ display: 'block', color: C.muted, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}{required && <span style={{ color: C.gold }}> *</span>}
      </label>
      {children}
    </div>
  )
}

function input(): React.CSSProperties {
  return {
    display: 'block', width: '100%', boxSizing: 'border-box',
    padding: '12px', marginBottom: '6px',
    background: C.panel, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: '8px',
    fontSize: '16px',   // 16px stops iOS Safari zooming the viewport on focus
    fontFamily: 'Arial, sans-serif',
  }
}

function btn(color: string, enabled: boolean): React.CSSProperties {
  return {
    display: 'block', width: '100%', marginTop: '14px',
    background: enabled ? color : C.panel,
    color: enabled ? '#0f1117' : C.faint,
    border: `1px solid ${enabled ? color : C.border}`,
    borderRadius: '8px', padding: '14px',
    fontSize: '15px', fontWeight: 'bold',
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}

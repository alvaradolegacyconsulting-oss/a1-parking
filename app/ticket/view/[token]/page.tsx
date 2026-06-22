import { createClient } from '@supabase/supabase-js'
import { displayTowReason } from '../../../lib/tow-reasons'

// Public read-only tow-ticket view (capability URL).
//
// The recipient gets a /ticket/view/<token> link from the driver
// (mobile share-sheet, mailto, or Copy link in the popup); clicks it;
// sees the ticket here. No login. The token IS the credential.
//
// The data fetch goes through get_violation_by_view_token (anon-
// callable, SECURITY DEFINER per migration 20260610_a1_tow_ticket_
// view_token.sql). The RPC gates on:
//   • token ≥ 32 chars
//   • view_token_expires_at > now()  (90-day expiry per Jose's lock)
//   • is_confirmed = true            (F10 — drafts never get a link)
// If any gate fails, we render the "not found / expired" UI.
//
// Photos render inline as <img src={photo_url}>. The violation-photos
// bucket is public today (pre-existing, conscious-accept per the
// preflight); v2 hardening would switch to private + signed URLs at
// this render boundary.

export const dynamic = 'force-dynamic'

interface ViolationRow {
  id: number
  plate: string
  state: string | null
  vehicle_year: number | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_color: string | null
  violation_type: string | null
  location: string | null
  notes: string | null
  property: string | null
  driver_name: string | null
  // B120 — operator license is snapshotted onto violations.driver_license
  // at insert time by the driver portal (driver/page.tsx:428). NULL for
  // manager-issued / CA-issued tickets — render show-if-present.
  driver_license: string | null
  tow_storage_name: string | null
  tow_storage_address: string | null
  tow_storage_phone: string | null
  tow_fee: number | string | null
  created_at: string
  // B120 — server-side resolved licensing values folded into the
  // violation payload by get_violation_by_view_token. Both null if
  // the source row doesn't exist or the field is unset on it.
  resolved_tdlr_license: string | null
  resolved_vsf_license: string | null
}

interface PhotoRow {
  id: number
  photo_url: string
}

type RpcResult =
  | { error: string }
  | { status: 'voided' }  // B175 — voided ticket. NO payload. Public page renders a clean voided-notice.
  | { violation: ViolationRow; photos: PhotoRow[] }

async function fetchTicket(token: string): Promise<RpcResult> {
  // B175 fix-up (2026-06-11) — defensive guards so the page component's
  // discriminator chain NEVER sees null/undefined/non-object. The page
  // does `'error' in result` and `'status' in result` to narrow — the
  // `in` operator throws TypeError on a non-object operand, which
  // produced "server error" on the voided-ticket smoke when something
  // in the fetch path bypassed the prior `if (error)` guard. Catch:
  //   • supabase.rpc returned an explicit error → fall through to
  //     not_found_or_expired (existing behavior).
  //   • supabase.rpc returned data = null/undefined/primitive →
  //     fall through (was the throw vector).
  //   • The RPC call itself threw → fall through (network / SSL /
  //     environment misconfig).
  // Anything reaching the page component is now guaranteed to be a
  // non-null object the `in` operator can safely walk.
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { data, error } = await supabase.rpc('get_violation_by_view_token', { p_token: token })
    if (error) {
      console.error('[ticket-view] RPC error:', error.message)
      return { error: 'not_found_or_expired' }
    }
    if (!data || typeof data !== 'object') {
      console.error('[ticket-view] RPC returned non-object data:', JSON.stringify(data))
      return { error: 'not_found_or_expired' }
    }
    return data as RpcResult
  } catch (e) {
    console.error('[ticket-view] fetchTicket threw:', e instanceof Error ? e.message : String(e))
    return { error: 'not_found_or_expired' }
  }
}

export default async function TicketViewPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  // Next 16 dynamic-route params are a Promise — must await before
  // destructure (per [[feedback-next-16-async-params]] / B85 lesson).
  const { token } = await params
  const result = await fetchTicket(token)

  // B175 — voided ticket: render the dedicated voided notice WITHOUT
  // the violation payload. Per Jose's Q6c lock: a violation is often
  // voided BECAUSE the data was wrong (wrong plate/vehicle); we must
  // not keep republishing the erroneous record on an anonymous public
  // URL. The RPC returns no plate/photos/location for voided rows;
  // this branch communicates that to the recipient cleanly.
  //
  // Discriminator: each variant has a unique key — `status` (voided),
  // `error` (not-found/expired/invalid), or `violation` + `photos`
  // (the OK payload). Check by key to give TS a clean narrowing.
  if ('error' in result) {
    return <NotFoundView reason={result.error} />
  }
  if ('status' in result) {
    return <VoidedView />
  }
  return <TicketView violation={result.violation} photos={result.photos} />
}

// ────────────────────────────────────────────────────────────────────
// Render — mirrors the print-template structure from driver/page.tsx
// (~lines 720-810) but as server-rendered JSX without the localStorage
// /driver-context dependencies. Inline styles for email-client and
// screenshot-friendly rendering.
// ────────────────────────────────────────────────────────────────────

function TicketView({ violation: v, photos }: { violation: ViolationRow; photos: PhotoRow[] }) {
  const total = (typeof v.tow_fee === 'string' ? parseFloat(v.tow_fee) : v.tow_fee) || 0
  const ticketNum = String(v.id).padStart(8, '0').substring(0, 8).toUpperCase()
  const createdAt = new Date(v.created_at).toLocaleString()
  const vehicleParts = [v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean)

  return (
    <main style={pageStyle}>
      <article style={cardStyle}>
        {/* Header */}
        <div style={hdrStyle}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 'bold' }}>Tow Ticket</div>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: '#C9A227', marginTop: 3 }}>
              OFFICIAL TOW TICKET
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#888' }}>Date / Time</div>
            <div style={{ fontWeight: 'bold' }}>{createdAt}</div>
            <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Ticket #</div>
            <div style={{ fontWeight: 'bold' }}>{ticketNum}</div>
          </div>
        </div>

        {/* Warning banner */}
        <div style={warnStyle}>
          ⚠ This vehicle has been towed pursuant to Texas Transportation Code §683. Contact the storage facility below to recover your vehicle.
        </div>

        {/* Vehicle */}
        <Section title="Vehicle Information">
          <Field label="License Plate" value={v.plate} mono />
          <Field label="State" value={v.state || '—'} />
          {v.vehicle_year ? <Field label="Year" value={String(v.vehicle_year)} /> : null}
          {vehicleParts.length ? (
            <Field
              label="Make / Model / Color"
              value={vehicleParts.join('  ·  ')}
              span2
            />
          ) : null}
        </Section>

        {/* Violation */}
        <Section title="Violation">
          <Field label="Type" value={displayTowReason(v.violation_type)} />
          <Field label="Location / Space" value={v.location || '—'} />
          <Field label="Notes" value={v.notes || 'No additional notes.'} span2 />
        </Section>

        {/* Property */}
        <Section title="Property">
          <Field label="Authorized By" value={v.property || '—'} span2 />
        </Section>

        {/* Tow Operator */}
        {/* B120 — operator license + TDLR render show-if-present (load-bearing:
            a null value renders nothing, never a blank line or placeholder).
            Operator Name always renders ('—' fallback) since name is the row's
            anchor; license + TDLR are additive disclosures. */}
        <Section title="Tow Operator">
          <Field label="Operator Name" value={v.driver_name || '—'} span2={!v.driver_license} />
          {v.driver_license ? <Field label="License #" value={v.driver_license} /> : null}
          {v.resolved_tdlr_license ? <Field label="TDLR #" value={v.resolved_tdlr_license} /> : null}
        </Section>

        {/* Storage */}
        <Section title="Storage / Impound">
          <Field label="Facility" value={v.tow_storage_name || '—'} />
          <Field label="Phone" value={v.tow_storage_phone || '—'} />
          <Field label="Address" value={v.tow_storage_address || '—'} span2 />
          {/* B120 — VSF show-if-present. */}
          {v.resolved_vsf_license ? <Field label="VSF #" value={v.resolved_vsf_license} span2 /> : null}
        </Section>

        {/* Fees */}
        {total > 0 ? (
          <Section title="Fees">
            <Field label="Tow Fee" value={`$${total.toFixed(2)}`} />
            <Field
              label="Total Due"
              value={`$${total.toFixed(2)}`}
              boldLarge
            />
          </Section>
        ) : null}

        {/* Photos */}
        {photos.length > 0 ? (
          <div style={{ marginTop: 20 }}>
            <div style={shTitleStyle}>Evidence Photos</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 8,
                marginTop: 8,
              }}
            >
              {photos.map((p) => (
                <img
                  key={p.id}
                  src={p.photo_url}
                  alt=""
                  style={{
                    width: '100%',
                    borderRadius: 4,
                    border: '1px solid #ddd',
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* Footer */}
        <div style={ftrStyle}>
          ShieldMyLot · Texas parking enforcement platform
          <br />
          This is a read-only view of an issued tow ticket.
        </div>
      </article>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={shTitleStyle}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
    </div>
  )
}

function Field({
  label,
  value,
  mono = false,
  span2 = false,
  boldLarge = false,
}: {
  label: string
  value: string
  mono?: boolean
  span2?: boolean
  boldLarge?: boolean
}) {
  return (
    <div style={{ ...(span2 ? { gridColumn: 'span 2' } : null) }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 'bold',
          color: '#555',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: boldLarge ? 16 : 13,
          color: '#111',
          marginTop: 1,
          fontWeight: boldLarge ? 'bold' : 'normal',
          fontFamily: mono ? '"Courier New", monospace' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  )
}

function NotFoundView({ reason }: { reason: string }) {
  const message =
    reason === 'invalid_token'
      ? 'This ticket link is malformed.'
      : 'This ticket link is not valid. It may have expired (links expire 90 days after issue), been regenerated, or never existed.'

  return (
    <main style={pageStyle}>
      <article style={{ ...cardStyle, textAlign: 'center', padding: 48 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
        <h1 style={{ fontSize: 22, fontWeight: 'bold', margin: '0 0 12px', color: '#0f1117' }}>
          Ticket not found
        </h1>
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.6, margin: 0 }}>{message}</p>
        <p style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginTop: 16 }}>
          If you believe this link should be valid, contact the tow operator or storage facility
          listed on your tow ticket.
        </p>
      </article>
    </main>
  )
}

// B175 — Voided ticket view. The RPC returns {status:'voided'} when a
// violation has been voided (voided_at IS NOT NULL), WITHOUT any
// payload (no plate, photos, location). The recipient sees a clean
// "voided / not in effect" notice. Rationale: a violation is often
// voided BECAUSE the data was wrong (wrong plate / wrong vehicle); we
// must not keep republishing the erroneous record on an anonymous
// public URL. The void branch fires even on links that have technically
// expired — "voided" is more informative than "expired/not found" for
// a recipient holding the link, and leaks no payload either way.
function VoidedView() {
  return (
    <main style={pageStyle}>
      <article style={{ ...cardStyle, textAlign: 'center', padding: 48, border: '2px solid #b71c1c' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🚫</div>
        <h1 style={{ fontSize: 22, fontWeight: 'bold', margin: '0 0 12px', color: '#b71c1c' }}>
          This ticket has been voided
        </h1>
        <p style={{ fontSize: 14, color: '#333', lineHeight: 1.6, margin: '0 0 16px', fontWeight: 'bold' }}>
          NOT IN EFFECT
        </p>
        <p style={{ fontSize: 13, color: '#555', lineHeight: 1.6, margin: 0 }}>
          The tow operator who issued this ticket has marked it voided. There is no fee owed
          and no action required from this notice.
        </p>
        <p style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginTop: 16 }}>
          If you have questions, contact the tow operator or storage facility that originally
          issued the ticket.
        </p>
      </article>
    </main>
  )
}

// ─── Inline styles (no localStorage / no client-side deps) ──────────

const pageStyle: React.CSSProperties = {
  fontFamily: 'Arial, sans-serif',
  background: '#f4f4f7',
  minHeight: '100vh',
  padding: '24px 12px',
  color: '#111',
  fontSize: 13,
}

const cardStyle: React.CSSProperties = {
  maxWidth: 680,
  margin: '0 auto',
  background: '#ffffff',
  borderRadius: 8,
  padding: 28,
}

const hdrStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  marginBottom: 22,
  paddingBottom: 14,
  borderBottom: '3px solid #C9A227',
}

const warnStyle: React.CSSProperties = {
  background: '#fff3cd',
  border: '1px solid #e6b800',
  borderRadius: 5,
  padding: '9px 12px',
  fontSize: 11,
  marginBottom: 16,
  lineHeight: 1.4,
}

const shTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 'bold',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#777',
  marginBottom: 8,
  paddingBottom: 3,
  borderBottom: '1px solid #eee',
}

const ftrStyle: React.CSSProperties = {
  marginTop: 28,
  paddingTop: 10,
  borderTop: '2px solid #C9A227',
  fontSize: 10,
  color: '#888',
  textAlign: 'center',
  lineHeight: 1.5,
}

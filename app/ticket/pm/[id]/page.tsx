import { createSupabaseServerClient } from '../../../lib/server-auth'
import { redirect } from 'next/navigation'

// Property-manager authenticated tow-ticket view (price-stripped, storage kept).
//
// B182 — distinct from /ticket/view/[token] (the public capability URL
// that goes to motorist + facility WITH price). This route is for the
// property manager's audience: they need to know a tow happened on their
// property AND where the vehicle went so they can direct the resident
// to recover it, but they should never see money fields (tow_fee). The
// price-free guarantee is enforced server-side by the
// get_pm_ticket_summary RPC, which EXPLICITLY enumerates returned
// fields and never returns tow_fee, view_token, or any other money /
// price-routing field. Hiding the price in render would be a security
// mistake — a PM screenshot or forwarded URL must not carry money info.
//
// Storage facility (tow_storage_name/address/phone) IS returned and
// rendered — PMs legitimately need to tell residents where the towed
// vehicle went. Storage isn't money. (Original spec over-stripped;
// corrected 2026-06-14.)
//
// Auth model:
//   • Authenticated manager / leasing_agent only (RPC guards both)
//   • Property-scope: caller must have v_row.property ∈ get_my_properties()
//   • Voided tickets refuse (PM never sees no-longer-in-effect tickets)
//
// Render shape mirrors the public capability URL's section structure so
// a PM seeing both has the same visual language — Storage section is
// present, Fees section is ABSENT (the actual price omission).

export const dynamic = 'force-dynamic'

interface PmViolation {
  id: number
  plate: string
  vehicle_year: number | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_color: string | null
  violation_type: string | null
  location: string | null
  notes: string | null
  property: string | null
  driver_name: string | null
  driver_license: string | null
  created_at: string
  tow_ticket_generated_at: string | null
  was_authorized_at_time: boolean | null
  decline_reason: string | null
  decline_reason_note: string | null
  // B182 storage fields (2026-06-14 spec correction): PM gets storage
  // facility info so they can tell residents where the towed vehicle
  // went. Money fields (tow_fee) remain absent from the RPC payload.
  tow_storage_name: string | null
  tow_storage_address: string | null
  tow_storage_phone: string | null
  video_url: string | null
}

interface Photo {
  id: number
  photo_url: string
}

type RpcResult =
  | { error: string }
  | { ok: true; violation: PmViolation; photos: Photo[] }

async function fetchPmTicket(id: number): Promise<RpcResult> {
  try {
    const supabase = await createSupabaseServerClient()
    const { data, error } = await supabase.rpc('get_pm_ticket_summary', { p_violation_id: id })
    if (error) {
      console.error('[ticket-pm] RPC error:', error.message)
      return { error: error.message }
    }
    if (!data || typeof data !== 'object') {
      console.error('[ticket-pm] RPC returned non-object:', JSON.stringify(data))
      return { error: 'unexpected_response' }
    }
    return data as RpcResult
  } catch (e) {
    console.error('[ticket-pm] fetchPmTicket threw:', e instanceof Error ? e.message : String(e))
    return { error: 'fetch_failed' }
  }
}

export default async function PmTicketPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Next 16 dynamic-route params are a Promise — must await before destructure
  // (per [[feedback-next-16-async-params]] / B85 lesson).
  const { id: idParam } = await params
  const id = parseInt(idParam, 10)

  if (!Number.isFinite(id) || id < 0) {
    return <NotAvailableView reason="invalid_id" />
  }

  // Auth check: server-client returns null user if no session.
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  const result = await fetchPmTicket(id)

  if ('error' in result) {
    return <NotAvailableView reason={result.error} />
  }

  return <PmTicketView violation={result.violation} photos={result.photos} />
}

function PmTicketView({ violation: v, photos }: { violation: PmViolation; photos: Photo[] }) {
  const createdAt = new Date(v.created_at).toLocaleString()
  const issuedAt = v.tow_ticket_generated_at ? new Date(v.tow_ticket_generated_at).toLocaleString() : null
  const ticketNum = String(v.id).padStart(8, '0').substring(0, 8).toUpperCase()
  const vehicleParts = [v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean)

  return (
    <main style={pageStyle}>
      <article style={cardStyle}>
        <div style={hdrStyle}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 'bold' }}>Tow Ticket Summary</div>
            <div style={{ fontSize: 13, color: '#888', marginTop: 3 }}>
              Property Manager View — operational summary, no fees
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#888' }}>Ticket #</div>
            <div style={{ fontWeight: 'bold' }}>{ticketNum}</div>
            <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Issued</div>
            <div style={{ fontWeight: 'bold' }}>{issuedAt ?? '—'}</div>
          </div>
        </div>

        <div style={infoBannerStyle}>
          This is the manager view of an issued tow ticket. Fees and pricing are intentionally not shown here — those appear on the public ticket the motorist and storage facility receive. Storage facility contact is included so you can direct residents to recover their vehicle.
        </div>

        <Section title="Vehicle">
          <Field label="License Plate" value={v.plate} mono />
          {v.vehicle_year ? <Field label="Year" value={String(v.vehicle_year)} /> : null}
          {vehicleParts.length ? (
            <Field label="Make / Model / Color" value={vehicleParts.join('  ·  ')} span2 />
          ) : null}
        </Section>

        <Section title="Violation">
          <Field label="Type" value={v.violation_type || '—'} />
          <Field label="Location / Space" value={v.location || '—'} />
          <Field label="Notes" value={v.notes || 'No additional notes.'} span2 />
          <Field label="Observed" value={createdAt} />
          {v.was_authorized_at_time != null ? (
            <Field label="Authorized at time" value={v.was_authorized_at_time ? 'Yes' : 'No'} />
          ) : null}
          {v.decline_reason ? <Field label="Decline reason" value={v.decline_reason} /> : null}
          {v.decline_reason_note ? <Field label="Decline note" value={v.decline_reason_note} span2 /> : null}
        </Section>

        <Section title="Property">
          <Field label="Property" value={v.property || '—'} span2 />
        </Section>

        <Section title="Tow Operator">
          <Field label="Name" value={v.driver_name || '—'} span2={!v.driver_license} />
          {v.driver_license ? <Field label="License #" value={v.driver_license} /> : null}
        </Section>

        {/* B182 — Storage / Impound (2026-06-14 spec correction). PM needs
            to tell residents where the towed vehicle went; storage isn't
            money. Fees section deliberately remains absent — that's the
            actual price omission. */}
        {(v.tow_storage_name || v.tow_storage_address || v.tow_storage_phone) ? (
          <Section title="Storage / Impound">
            <Field label="Facility" value={v.tow_storage_name || '—'} />
            <Field label="Phone" value={v.tow_storage_phone || '—'} />
            <Field label="Address" value={v.tow_storage_address || '—'} span2 />
          </Section>
        ) : null}

        {photos.length > 0 ? (
          <div style={{ marginTop: 20 }}>
            <div style={shTitleStyle}>Evidence Photos</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 }}>
              {photos.map((p) => (
                <img key={p.id} src={p.photo_url} alt="" style={{ width: '100%', borderRadius: 4, border: '1px solid #ddd' }} />
              ))}
            </div>
          </div>
        ) : null}

        {v.video_url ? (
          <div style={{ marginTop: 20 }}>
            <div style={shTitleStyle}>Evidence Video</div>
            <video src={v.video_url} controls style={{ width: '100%', maxWidth: 480, marginTop: 8, borderRadius: 4 }} />
          </div>
        ) : null}

        <div style={ftrStyle}>
          ShieldMyLot · Manager view of tow ticket {ticketNum}
          <br />
          Fees and storage facility contact appear only on the motorist + facility copies.
        </div>
      </article>
    </main>
  )
}

function NotAvailableView({ reason }: { reason: string }) {
  const copy: Record<string, { title: string; body: string }> = {
    invalid_id:           { title: 'Invalid ticket reference',     body: 'The URL does not include a valid ticket id.' },
    no_role_assigned:    { title: 'No role assigned',              body: 'Your account doesn\'t have a role assignment. Contact your administrator.' },
    role_not_authorized: { title: 'Not available to your role',    body: 'This view is for property managers and leasing agents. Drivers and company admins use the public ticket link.' },
    no_property_scope:   { title: 'No property scope',             body: 'Your account isn\'t scoped to any properties yet. Contact your administrator.' },
    not_found:           { title: 'Ticket not found',              body: 'No violation matches that id, or it has been removed.' },
    out_of_scope:        { title: 'Out of your property scope',    body: 'This ticket belongs to a property you don\'t manage.' },
    not_confirmed:       { title: 'Ticket not yet confirmed',      body: 'This violation hasn\'t been confirmed by the operator yet.' },
    voided:              { title: 'This ticket has been voided',   body: 'The tow operator marked this ticket voided. If a corrected ticket was issued, it will appear in your violations list as a separate entry.' },
    not_ticketed:        { title: 'No tow ticket issued',          body: 'This violation has been confirmed but no tow ticket has been generated.' },
  }
  const c = copy[reason] || { title: 'Ticket unavailable', body: 'This ticket isn\'t available to view right now.' }
  return (
    <main style={pageStyle}>
      <article style={{ ...cardStyle, textAlign: 'center', padding: 48 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
        <h1 style={{ fontSize: 22, fontWeight: 'bold', margin: '0 0 12px', color: '#0f1117' }}>{c.title}</h1>
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.6, margin: 0 }}>{c.body}</p>
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

function Field({ label, value, mono = false, span2 = false }: { label: string; value: string; mono?: boolean; span2?: boolean }) {
  return (
    <div style={{ ...(span2 ? { gridColumn: 'span 2' } : null) }}>
      <div style={{ fontSize: 10, fontWeight: 'bold', color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111', marginTop: 1, fontFamily: mono ? '"Courier New", monospace' : undefined }}>{value}</div>
    </div>
  )
}

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

const infoBannerStyle: React.CSSProperties = {
  background: '#e8eef6',
  border: '1px solid #b5c5dc',
  borderRadius: 5,
  padding: '9px 12px',
  fontSize: 11,
  marginBottom: 16,
  lineHeight: 1.4,
  color: '#3a4a60',
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

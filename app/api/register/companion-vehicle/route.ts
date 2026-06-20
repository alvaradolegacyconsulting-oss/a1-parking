import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'

// B209 — /register companion-vehicle server-side insert proxy.
//
// PURPOSE
//   Closes the silent-permission-denied gap surfaced by Jose's UAT
//   2026-06-19 against test resident "New Resk" (alvaradolegacyconsutling+
//   addres@gmail.com / Unit 503 / Bayou Heights Apartments). The
//   /register companion-vehicle insert was previously a client-side
//   .from('vehicles').insert(...) that relied on the
//   resident_insert_vehicles RLS policy. That policy was DROPped by the
//   cascading-deactivation arc (7da03d2, 2026-06-17,
//   migrations/20260617_deactivation_model.sql:303) — the policy DROP
//   was correct (single-resident-write-path discipline), but /register
//   was not updated to use the replacement DEFINER RPC, and the
//   .from().insert() call site had NO error capture. Net: every public
//   self-register attempt with a vehicle silently dropped the vehicle.
//
//   The request_my_vehicle DEFINER RPC (the resident-portal path) can't
//   serve /register here either: its body-guard requires
//   get_my_effective_active()=TRUE which is FALSE for a just-registered
//   pending resident (residents.is_active=false until manager approves).
//   So this route uses a service-role admin client to bypass RLS
//   entirely, scoped server-side to THIS user's residents row.
//
// SCOPE (Option A MINIMAL per Jose's design sign-off)
//   Only the vehicle insert moves server-side. The /register flow's
//   client-side residents + user_roles inserts (which currently work
//   end-to-end and have error handling) are left untouched. (Option B —
//   move the whole post-auth sequence server-side — is a follow-on
//   B-number IF a partial-state incident actually occurs.)
//
// AUTH
//   Cookie-bound supabase client → auth.getUser() → 401 if missing.
//   Runs immediately after /register's signInWithPassword; the session
//   is freshly minted. Added to middleware publicPaths to defend
//   against the cookie-propagation race window (same B65/B108 hotfix
//   class) — the route itself still gates on auth.getUser().
//
// AUTHORIZATION (load-bearing)
//   Scope is DERIVED from the residents row, NOT the request body.
//   The caller can supply only the COSMETIC vehicle fields (plate,
//   state, make, model, year, color). The unit, property, and
//   resident_email come from a server-side lookup of residents WHERE
//   lower(email) = lower(auth.jwt.email). This closes the
//   cross-resident-insert hole before it can exist: a sophisticated
//   caller can't supply a different unit/property/email to scope an
//   insert into someone else's space.
//
// CAPTCHA — VERIFIED UPSTREAM at /api/register/captcha-verify
//   By the time this route runs, the caller has a valid session that only
//   exists because they cleared CAPTCHA upstream — /register's submit
//   handler calls /api/register/captcha-verify FIRST (before swift-handler);
//   if that gate fails, the flow aborts and no auth.users row is created,
//   no signInWithPassword happens, no session exists. So by the time the
//   client's fetch lands here, the active session IS the proof that
//   CAPTCHA passed. This route trusts the session as the proof and does
//   NOT verify a token itself — verifying again would fail by design
//   because Turnstile tokens are single-use. The captcha-verify wrapper
//   is single-responsibility (verify-and-200, or 4xx/5xx + abort).
//
// SOFT-FAIL DISCIPLINE (B167 pattern, sharpened per B209 sign-off)
//   Per-vehicle insert failures DO NOT roll back the user/resident/role
//   rows that landed in earlier /register steps. The route returns 200
//   with a soft-fail aggregate; /register surfaces a TOW-STAKES
//   warning (not a generic "save failure" footnote — the resident
//   needs to register the vehicle in their portal or it's tow-eligible).
//   Every failure path is also tagged-logged via console.error so the
//   silent-swallow class that caused B209 cannot recur.
//
// FIELD-SHAPE MATCH WITH MANAGER QUEUE
//   Insert side:  status='pending', is_active=false, property+unit from
//                 residents row, resident_email=lower(residents.email)
//   Queue side:   manager/page.tsx:364 fetchVehicles selects WHERE
//                 ilike('property') and filters status==='pending'
//   Confirmed match: pending vehicles inserted via this route appear in
//   the manager's pending-approval queue immediately.

export const runtime = 'nodejs'

type VehicleInput = {
  plate?: string
  state?: string
  make?: string | null
  model?: string | null
  year?: number | null
  color?: string | null
}

type SuccessResponse = {
  ok: true
  vehicles_attempted: number
  vehicles_inserted: number
  vehicles_failed: number
  inserted_plates: string[]
  failed_plates: string[]
  gap_message: string | null
  error_class: string | null
}

type ErrorResponse = {
  ok: false
  error: string
  error_class: string
}

function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Sharper-than-generic copy per B209 design sign-off. The downstream
// consequence of the resident ignoring this is their car getting TOWED.
// Match urgency to stakes — explicit "NOT REGISTERED" + tow-eligible
// language + concrete next action. /register's UI renders this in a
// prominent warning band, not a footnote.
function buildGapMessage(failedPlates: string[]): string {
  const n = failedPlates.length
  const plateList = failedPlates.join(', ')
  if (n === 1) {
    return `⚠ Your vehicle ${plateList} is NOT yet registered and could be towed if parked at your property. Sign in to your resident portal now and submit it through "Request a Vehicle" — it only takes a minute and you'll see status updates as your manager approves.`
  }
  return `⚠ ${n} of your vehicles (${plateList}) are NOT yet registered and could be towed if parked at your property. Sign in to your resident portal now and submit each through "Request a Vehicle" — it only takes a minute and you'll see status updates as your manager approves.`
}

export async function POST(req: NextRequest): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  // ── 1. CAPTCHA — verified upstream, NOT here ─────────────────────
  // See header docblock. /api/register/captcha-verify ran first and
  // returned 200 before the /register flow reached swift-handler →
  // signInWithPassword → THIS route. The active session below is the
  // proof that CAPTCHA passed. Re-verifying the single-use Turnstile
  // token here would fail by design.

  // ── 2. Auth — cookie-bound supabase client → auth.getUser() ──
  let supabase
  try {
    supabase = await createSupabaseServerClient()
  } catch (e) {
    console.error('[B209-server-client-init-failed]', { error: (e as Error).message })
    return NextResponse.json(
      { ok: false, error: 'Server initialization failed.', error_class: 'server_init' },
      { status: 500 },
    )
  }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) {
    return NextResponse.json(
      { ok: false, error: 'Not authenticated.', error_class: 'unauthenticated' },
      { status: 401 },
    )
  }
  const callerEmail = user.email.toLowerCase()

  // ── 3. Parse + validate body ──
  let body: { vehicles?: VehicleInput[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body.', error_class: 'bad_body' },
      { status: 400 },
    )
  }
  const rawVehicles = Array.isArray(body.vehicles) ? body.vehicles : []
  // Filter empty/blank plate entries server-side too (defense — client
  // already filters, but the route shouldn't trust it). Keep only the
  // cosmetic fields. unit/property/resident_email come from the
  // residents row below, NOT the body.
  const vehicles = rawVehicles
    .filter(v => typeof v.plate === 'string' && v.plate.trim().length > 0)
    .map(v => ({
      plate: normalizePlate(String(v.plate).trim()),
      state: typeof v.state === 'string' ? v.state : 'TX',
      make: typeof v.make === 'string' && v.make.trim().length > 0 ? v.make.trim() : null,
      model: typeof v.model === 'string' && v.model.trim().length > 0 ? v.model.trim() : null,
      year: typeof v.year === 'number' && Number.isFinite(v.year) ? v.year : null,
      color: typeof v.color === 'string' && v.color.trim().length > 0 ? v.color.trim() : null,
    }))
    .filter(v => v.plate.length > 0)  // re-check after normalize (handles all-punctuation plates)

  if (vehicles.length === 0) {
    // Not an error — caller submitted no vehicles, route is a no-op.
    return NextResponse.json({
      ok: true,
      vehicles_attempted: 0,
      vehicles_inserted: 0,
      vehicles_failed: 0,
      inserted_plates: [],
      failed_plates: [],
      gap_message: null,
      error_class: null,
    })
  }

  // ── 4. Server-side residents-row lookup (scope source of truth) ──
  // Service-role client; bypasses RLS. We are deriving authorization
  // scope from THIS user's residents row, not trusting the request.
  const admin = createSupabaseServiceClient()
  const { data: residentRow, error: rErr } = await admin
    .from('residents')
    .select('email, unit, property')
    .ilike('email', callerEmail)
    .maybeSingle()

  if (rErr) {
    console.error('[B209-residents-lookup-failed]', { caller_email: callerEmail, error: rErr.message })
    return NextResponse.json(
      { ok: false, error: 'Could not look up resident record.', error_class: 'residents_lookup' },
      { status: 500 },
    )
  }
  if (!residentRow?.unit || !residentRow?.property) {
    // Should not happen post-/register-step-4 (residents INSERT). Defensive.
    console.error('[B209-no-residents-row]', { caller_email: callerEmail })
    return NextResponse.json(
      { ok: false, error: 'No resident record found for caller — registration incomplete.', error_class: 'no_residents_row' },
      { status: 400 },
    )
  }

  // ── 5. INSERT — admin client bypasses the dropped RLS policy ──
  // Per-row insert (not batch insert) so a single bad row doesn't fail
  // the whole batch. Aggregate the result; partial success → soft-fail
  // aggregate with tow-stakes gap message.
  const insertedPlates: string[] = []
  const failedPlates: string[] = []
  let lastErrorClass: string | null = null
  for (const v of vehicles) {
    const { error: insErr } = await admin
      .from('vehicles')
      .insert([{
        plate: v.plate,
        state: v.state,
        make: v.make,
        model: v.model,
        year: v.year,
        color: v.color,
        // Scope fields — from residents row, NOT body.
        unit: residentRow.unit,
        property: residentRow.property,
        resident_email: residentRow.email.toLowerCase(),
        // Pending-approval state — matches both /register's original
        // intent and the manager queue's status='pending' predicate.
        is_active: false,
        status: 'pending',
      }])
    if (insErr) {
      // Tagged log so the silent-swallow class that caused B209 cannot
      // recur. The user-visible warning + the engineer-side log
      // together prove that every failure path is observable.
      console.error('[B209-register-vehicle-insert-failed]', {
        caller_email: callerEmail,
        plate: v.plate,
        property: residentRow.property,
        unit: residentRow.unit,
        error: insErr.message,
      })
      failedPlates.push(v.plate)
      lastErrorClass = 'admin_insert_failed'
    } else {
      insertedPlates.push(v.plate)
    }
  }

  return NextResponse.json({
    ok: true,
    vehicles_attempted: vehicles.length,
    vehicles_inserted: insertedPlates.length,
    vehicles_failed: failedPlates.length,
    inserted_plates: insertedPlates,
    failed_plates: failedPlates,
    gap_message: failedPlates.length > 0 ? buildGapMessage(failedPlates) : null,
    error_class: lastErrorClass,
  })
}

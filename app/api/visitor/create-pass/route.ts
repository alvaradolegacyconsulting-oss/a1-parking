import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { verifyTurnstile } from '../../../lib/turnstile-verify'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'

// /api/visitor/create-pass — CAPTCHA-gated wrapper for the anon
// create_visitor_pass RPC. Replaces /visitor's direct anon RPC call.
//
// FLOW
//   1. Verify Turnstile token via shared helper
//   2. On success: call create_visitor_pass RPC via service-role client
//      (RPC is SECURITY DEFINER + anon-granted per B74, so service-role
//      is just for blast-radius isolation — the RPC body's logic
//      (visitor_pass_limit trigger, B19 per-plate concurrent check,
//      VISITOR_TOS_ACCEPTED audit row) all run unchanged)
//   3. Return RPC result (success or error) to the client
//
// SCOPE — same call shape as today's /visitor direct RPC, just with the
// CAPTCHA gate in front. NO change to the RPC, NO new column, NO new
// policy. Matches Option A from the 2026-06-19 CAPTCHA preflight.
//
// FAIL-CLOSED — every non-OK path returns a 4xx/5xx response. /visitor
// surfaces the error message as a friendly retry prompt. No silent
// pass-through. Token reset on /visitor side so the user can re-
// challenge without a page reload.

export const runtime = 'nodejs'

interface VisitorPassBody {
  captchaToken?: string
  plate?: string
  visitor_name?: string
  visiting_unit?: string
  property?: string
  vehicle_desc?: string
  duration_hours?: number
}

export async function POST(req: NextRequest) {
  let body: VisitorPassBody = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body.', error_class: 'bad_body' },
      { status: 400 },
    )
  }

  // ── 1. CAPTCHA verify ────────────────────────────────────────────
  const remoteIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const captchaResult = await verifyTurnstile(body.captchaToken, remoteIp)
  if (!captchaResult.ok) {
    switch (captchaResult.reason) {
      case 'missing_token':
        return NextResponse.json(
          { ok: false, error: 'CAPTCHA challenge was not completed.', error_class: 'missing_token' },
          { status: 400 },
        )
      case 'missing_secret':
        console.error('[B-CAPTCHA] /api/visitor/create-pass: TURNSTILE_SECRET_KEY not set on Vercel')
        return NextResponse.json(
          { ok: false, error: 'CAPTCHA service is not configured. Please contact support.', error_class: 'missing_secret' },
          { status: 500 },
        )
      case 'rejected':
        console.warn('[B-CAPTCHA] /api/visitor/create-pass: token rejected', { detail: captchaResult.detail })
        return NextResponse.json(
          { ok: false, error: 'CAPTCHA verification failed. Please try again.', error_class: 'rejected' },
          { status: 400 },
        )
      case 'network_error':
        console.error('[B-CAPTCHA] /api/visitor/create-pass: network error', { detail: captchaResult.detail })
        return NextResponse.json(
          { ok: false, error: 'CAPTCHA service is temporarily unavailable. Please try again in a moment.', error_class: 'network_error' },
          { status: 503 },
        )
    }
  }

  // ── 2. Required-field validation ─────────────────────────────────
  // Same fields /visitor was sending to the RPC directly. Validate
  // here so the RPC doesn't get junk inputs that would surface as
  // confusing PostgreSQL errors to the user.
  const plate = (body.plate ?? '').trim()
  const visitorName = (body.visitor_name ?? '').trim()
  const visitingUnit = (body.visiting_unit ?? '').trim()
  const property = (body.property ?? '').trim()
  const vehicleDesc = (body.vehicle_desc ?? '').trim()
  const durationHours = typeof body.duration_hours === 'number' ? body.duration_hours : parseInt(String(body.duration_hours ?? ''), 10)

  if (!plate || !visitingUnit || !property || !Number.isFinite(durationHours) || durationHours <= 0) {
    return NextResponse.json(
      { ok: false, error: 'Missing required fields (plate, visiting_unit, property, duration_hours).', error_class: 'bad_body' },
      { status: 400 },
    )
  }

  // ── 3. Call create_visitor_pass RPC via service-role client ──────
  // RPC is SECURITY DEFINER + granted to anon+authenticated per
  // migrations/20260526_public_grant_retrofit_named5.sql. Service-role
  // here is for blast-radius isolation — bypasses any future anon-
  // policy tightening; the RPC body remains the source of truth for
  // visitor-pass-limit + B19 per-plate concurrent enforcement +
  // VISITOR_TOS_ACCEPTED audit row.
  const admin = createSupabaseServiceClient()
  const { error: rpcErr } = await admin.rpc('create_visitor_pass', {
    p_plate: plate,
    p_visitor_name: visitorName,
    p_visiting_unit: visitingUnit,
    p_property: property,
    p_vehicle_desc: vehicleDesc,
    p_duration_hours: durationHours,
  })

  if (rpcErr) {
    // RPC errors include B19 friendly trigger messages (visitor pass
    // limit / per-plate concurrent). Pass through the raw message so
    // /visitor can parseLimitTriggerError() as it does today.
    console.error('[B-CAPTCHA] /api/visitor/create-pass: RPC failed', { plate, property, error: rpcErr.message })
    return NextResponse.json(
      { ok: false, error: rpcErr.message, error_class: 'rpc_error' },
      { status: 400 },
    )
  }

  return NextResponse.json({ ok: true })
}

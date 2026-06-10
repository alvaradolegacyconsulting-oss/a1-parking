import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { FEATURE_FLAGS } from '../../../lib/feature-flags'
import { TIER_CONFIG } from '../../../lib/tier-config'
import {
  validateRows,
  MAX_UPLOAD_ROWS,
  type EntityType,
  type DriverRow,
  type ResidentRow,
} from '../../../lib/bulk-upload-helpers'

// B113 commit 2 — bulk invite + entity insert for company_admin.
//
// Flow per request:
//   1. Auth — company_admin only (RLS allows the entity inserts via
//      session); enforce role + presence of company linkage
//   2. Tier-gate — bulk_upload feature flag must be true on caller's
//      tier (Starter/Essential return 403 with upgrade-prompt message)
//   3. PM-no-driver — drivers entity rejected on PM track (Cluster 2.1)
//   4. 500-row cap (P5.4) — soft cap to keep Vercel function timeout +
//      Resend rate limits in safe range
//   5. Re-validate rows server-side (client validation is UX; server
//      is authoritative)
//   6. Pre-upload cap check (Layer 1) — DRIVERS ONLY (residents are
//      non-billable, no MAX_RESIDENTS cap per May 25 correction)
//   7. Property-existence validation (residents — required field)
//   8. Per-row processing:
//        a. inviteUserByEmail (service-role — only required service-
//           role call per F.3 counter-proposal)
//        b. insert_user_role RPC (authenticated session)
//        c. set_must_change_password=true RPC (graceful degrade)
//        d. INSERT entity row (drivers or residents — RLS-gated via
//           authenticated session matching company_admin policies)
//        e. INSERT companion vehicles row if vehicle_plate populated
//           (residents only; non-fatal if it fails)
//        f. audit_logs row (per-row entry, action=BULK_UPLOAD_<ENTITY>,
//           new_values=parsed row for forensic review)
//
// Per-row continue-on-error: an individual row failure (e.g., already-
// invited email, DB trigger rejection on a per-row driver cap violation
// past Layer 1) reports the error + moves to the next row. Pre-upload
// validation (steps 6-7) catches the systemic case; per-row errors
// are individual data issues. Pre-flight ask L locked this distinction.

export const runtime = 'nodejs'
export const maxDuration = 60

interface RequestBody {
  entity: EntityType
  rows: Array<Record<string, unknown>>
}

export async function POST(req: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .single()
  if (roleErr || !roleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (roleRow.role !== 'company_admin') {
    return NextResponse.json({ error: 'company_admin required' }, { status: 403 })
  }
  if (!roleRow.company) {
    return NextResponse.json({ error: 'no company associated with this account' }, { status: 404 })
  }

  // ── 2. Read request body ─────────────────────────────────────────
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const { entity, rows } = body
  if (entity !== 'driver' && entity !== 'resident') {
    return NextResponse.json({ error: 'entity must be "driver" or "resident"' }, { status: 400 })
  }
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: 'rows must be an array' }, { status: 400 })
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no rows to upload' }, { status: 400 })
  }
  if (rows.length > MAX_UPLOAD_ROWS) {
    return NextResponse.json(
      { error: `upload exceeds ${MAX_UPLOAD_ROWS}-row limit (got ${rows.length}). Split into smaller batches.` },
      { status: 400 }
    )
  }

  // ── 3. Tier-gate + B66.5 c4.3 account_state guard ─────────────────
  // SELECT extended to include account_state for the dunning lifecycle
  // guard. Past_due → warn but allow (per Q5 lock: CAs may be onboarding
  // new residents/drivers during the same window they're sorting payment
  // issues; blocking creates operational friction). Suspended/cancelled
  // → block with informative message.
  const { data: companyData, error: companyErr } = await supabase
    .from('companies')
    .select('tier, tier_type, account_state')
    .ilike('name', roleRow.company)
    .single()
  if (companyErr || !companyData) {
    return NextResponse.json({ error: 'company not found' }, { status: 404 })
  }

  // B66.5 commit 4.3: account_state guard. Suspended + cancelled block;
  // past_due warns but continues. Active/configuring fall through normally.
  const warnings: string[] = []
  if (companyData.account_state === 'suspended') {
    return NextResponse.json(
      {
        error: 'Bulk upload is unavailable while your account is suspended. ' +
               'Update payment method to restore access.',
      },
      { status: 403 }
    )
  }
  if (companyData.account_state === 'cancelled') {
    return NextResponse.json(
      {
        error: 'Bulk upload is unavailable on cancelled accounts. To restore the ' +
               'account, contact support@shieldmylot.com within 30 days of cancellation.',
      },
      { status: 403 }
    )
  }
  if (companyData.account_state === 'past_due') {
    warnings.push(
      'Your account is past due. New invites will still be sent, but service ' +
      'may be interrupted if payment is not resolved.'
    )
    // Continue to invite flow
  }

  const tierType = companyData.tier_type as 'enforcement' | 'property_management'
  const tierCfg = TIER_CONFIG[tierType]?.[companyData.tier]
  if (!tierCfg) {
    return NextResponse.json({ error: `unknown tier configuration (${tierType}/${companyData.tier})` }, { status: 500 })
  }
  if (tierCfg[FEATURE_FLAGS.BULK_UPLOAD] !== true) {
    return NextResponse.json(
      { error: `Bulk upload is not available on your tier (${companyData.tier}). Upgrade to enable.` },
      { status: 403 }
    )
  }

  // ── 4. PM-no-driver guard ────────────────────────────────────────
  if (entity === 'driver' && tierType === 'property_management') {
    return NextResponse.json(
      { error: 'Driver bulk upload not available on property management track (Cluster 2.1).' },
      { status: 400 }
    )
  }

  // ── 5. Re-validate rows server-side ──────────────────────────────
  const validated = validateRows(entity, rows)
  if (!validated.ok) {
    return NextResponse.json(
      { error: 'row validation failed', row_errors: validated.errors },
      { status: 400 }
    )
  }

  // ── 6. Pre-upload cap check (Layer 1 — drivers only) ─────────────
  // Residents have NO MAX_RESIDENTS tier-cap per May 25 correction
  // (residents are non-billable; 500-row per-upload cap is the only
  // resident-count guardrail).
  if (entity === 'driver') {
    const maxDrivers = (tierCfg[FEATURE_FLAGS.MAX_DRIVERS] as number) ?? -1
    if (maxDrivers !== -1) {
      const { count: currentActive, error: countErr } = await supabase
        .from('drivers')
        .select('*', { count: 'exact', head: true })
        .ilike('company', roleRow.company)
        .eq('is_active', true)
      if (countErr) {
        return NextResponse.json({ error: 'driver count probe failed: ' + countErr.message }, { status: 500 })
      }
      const current = currentActive ?? 0
      const after = current + validated.rows.length
      if (after > maxDrivers) {
        const remaining = Math.max(0, maxDrivers - current)
        return NextResponse.json(
          {
            error: `Upload would create ${validated.rows.length} drivers, but your ${companyData.tier} tier limit is ${maxDrivers}. You currently have ${current} active. Reduce upload to ≤${remaining} rows or upgrade tier.`,
          },
          { status: 400 }
        )
      }
    }
  }

  // ── 7. Property-existence validation (residents) ──────────────────
  if (entity === 'resident') {
    const residentRows = validated.rows as ResidentRow[]
    const propertyNames = Array.from(new Set(residentRows.map(r => r.property)))
    const { data: existingProps, error: propsErr } = await supabase
      .from('properties')
      .select('name')
      .ilike('company', roleRow.company)
    if (propsErr) {
      return NextResponse.json({ error: 'property lookup failed: ' + propsErr.message }, { status: 500 })
    }
    const existingNames = new Set((existingProps ?? []).map(p => String(p.name).toLowerCase()))
    const missing = propertyNames.filter(n => !existingNames.has(n.toLowerCase()))
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `Property names not found for company: ${missing.join(', ')}. Add the properties to your account first or correct the CSV.`,
        },
        { status: 400 }
      )
    }
  }

  // ── 8. Per-row processing ─────────────────────────────────────────
  const service = createSupabaseServiceClient()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  const inviteRedirect = `${origin}/reset-password-required`

  const results: Array<{ email: string; status: 'success' | 'error'; error?: string }> = []

  for (const row of validated.rows) {
    try {
      // 8a. Invite — service-role required (Auth admin API)
      const { error: inviteErr } = await service.auth.admin.inviteUserByEmail(row.email, {
        redirectTo: inviteRedirect,
      })
      if (inviteErr) {
        // "User already registered" is a common idempotent case for re-runs.
        // Don't continue past this — the auth user must exist for the
        // subsequent inserts to be meaningful for the user.
        results.push({ email: row.email, status: 'error', error: 'invite: ' + inviteErr.message })
        continue
      }

      // 8b. insert_user_role RPC (existing helper; SECURITY DEFINER)
      const propertyArr = entity === 'driver'
        ? (row as DriverRow).assigned_properties
        : [(row as ResidentRow).property]
      const role = entity === 'driver' ? 'driver' : 'resident'
      const { error: roleInsertErr } = await supabase.rpc('insert_user_role', {
        p_email: row.email,
        p_role: role,
        p_company: roleRow.company,
        p_property: propertyArr,
      })
      if (roleInsertErr) {
        results.push({ email: row.email, status: 'error', error: 'user_role: ' + roleInsertErr.message })
        continue
      }

      // 8c. Set must_change_password=true (graceful degrade if it fails)
      const { error: mcpErr } = await supabase.rpc('set_must_change_password', {
        p_email: row.email,
        p_value: true,
      })
      if (mcpErr) {
        console.error('[bulk-invite] set_must_change_password failed for', row.email, mcpErr.message)
        // Non-fatal — user will see /change-password on first login if
        // the flag wasn't set; not blocking the upload.
      }

      // 8d. INSERT entity row (RLS via authenticated company_admin policy)
      if (entity === 'driver') {
        const drv = row as DriverRow
        const { error: drvErr } = await supabase.from('drivers').insert([{
          email: drv.email,
          name: drv.name,
          company: roleRow.company,
          assigned_properties: drv.assigned_properties,
          is_active: true,
        }])
        if (drvErr) {
          results.push({ email: row.email, status: 'error', error: 'drivers: ' + drvErr.message })
          continue
        }
      } else {
        const res = row as ResidentRow
        const { error: resErr } = await supabase.from('residents').insert([{
          email: res.email,
          name: res.name,
          company: roleRow.company,
          property: res.property,
          unit: res.unit,
          status: 'active',
          is_active: true,
        }])
        if (resErr) {
          results.push({ email: row.email, status: 'error', error: 'residents: ' + resErr.message })
          continue
        }

        // 8e. Companion vehicle INSERT if vehicle_plate populated.
        // Non-fatal — resident row exists; customer can add the vehicle
        // later via /resident portal if this insert fails.
        if (res.vehicle_plate) {
          const { error: vehErr } = await supabase.from('vehicles').insert([{
            plate: res.vehicle_plate,
            state: res.vehicle_state,
            make: res.vehicle_make,
            model: res.vehicle_model,
            color: res.vehicle_color,
            // B166 — defensive normalize at the stamp site so the
            // deactivation-time owner-trim match is reliable regardless
            // of what validateRows does upstream.
            resident_email: res.email.trim().toLowerCase(),
            company: roleRow.company,
            property: res.property,
            unit: res.unit,
            status: 'active',
            is_active: true,
          }])
          if (vehErr) {
            console.error('[bulk-invite] companion vehicle insert failed for', res.email, vehErr.message)
          }
        }
      }

      // 8f. Audit log — per-row entry. action=BULK_UPLOAD_DRIVER or
      // BULK_UPLOAD_RESIDENT; new_values carries the parsed row for
      // forensic review (the audit-pass discipline file's catch:
      // don't add a source column; reuse action with prefix +
      // new_values JSONB).
      await supabase.from('audit_logs').insert([{
        user_email: user.email,
        action: 'BULK_UPLOAD_' + entity.toUpperCase(),
        table_name: entity === 'driver' ? 'drivers' : 'residents',
        record_id: row.email,
        new_values: row,
      }])

      results.push({ email: row.email, status: 'success' })
    } catch (e) {
      results.push({ email: row.email, status: 'error', error: (e as Error).message })
    }
  }

  return NextResponse.json({
    ok: true,
    total: rows.length,
    successful: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'error').length,
    results,
    // B66.5 commit 4.3: optional warnings array (populated when account_state
    // is past_due — invites went out but customer should resolve billing).
    // Client UI surfaces in amber state per the bulk-upload page handler.
    ...(warnings.length > 0 && { warnings }),
  })
}

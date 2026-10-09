// B203 backfill — one-shot service-role insert for the 8 residents
// Chris bulk-uploaded before the company-column fix landed.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// /api/billing/bulk-invite created the residents + sent invites for
// all 8 rows, but the companion vehicles INSERT failed silently
// (PostgREST schema-cache rejection on the bogus `company` field).
// The residents rows + invites are valid; only the vehicles half is
// missing. This script inserts ONLY the missing vehicles for those
// 8 specific residents — preserves residents + invites, no duplicate
// emails, no overlapping writes.
//
// ── SAFETY POSTURE ──────────────────────────────────────────────────
// DRY-RUN is the DEFAULT. The script prints exactly what it would do
// and exits without writing. Set EXECUTE=1 to actually insert.
//
// Before any insert the script:
//   1. Validates the resident row exists (skips orphans / typos)
//   2. Checks whether ANY vehicle already exists for that
//      (resident_email, property, unit) — if a vehicle is already
//      present (whether from a manual add or a partial earlier run),
//      the script skips that row to avoid creating a duplicate
//   3. Logs every action with PASS / SKIP / ERROR per row
//
// All writes go through service-role (RLS bypass). Inserts mirror the
// post-B203 bulk-invite payload exactly: no company field; ownership
// scope via resident_email + (property, unit); status='active' +
// is_active=true (matches the auto-approved bulk-residents semantic).
//
// ── INPUT FORMAT ────────────────────────────────────────────────────
// Provide BACKFILL_ROWS_JSON env var as a JSON array of objects with
// these fields (case-insensitive, mirroring the bulk template):
//   { email, vehicle_plate, vehicle_state, vehicle_make,
//     vehicle_model, vehicle_color }
// The script reads property + unit from the existing residents row
// for each email so a typo can't write to the wrong scope.
//
// ── USAGE ───────────────────────────────────────────────────────────
//   # DRY-RUN (default; shows what would be inserted):
//   BACKFILL_ROWS_JSON='[{"email":"a@x.com","vehicle_plate":"ABC123",
//     "vehicle_state":"TX","vehicle_make":"Toyota","vehicle_model":"Camry",
//     "vehicle_color":"Black"}, ...]' \
//     npx tsx --env-file=.env.local scripts/backfill-b203-orphaned-vehicles.ts
//
//   # LIVE (writes):
//   EXECUTE=1 BACKFILL_ROWS_JSON='...' \
//     npx tsx --env-file=.env.local scripts/backfill-b203-orphaned-vehicles.ts

import { createClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const execute    = process.env.EXECUTE === '1'
const rowsRaw    = process.env.BACKFILL_ROWS_JSON

if (!rowsRaw) {
  console.error('ERROR: BACKFILL_ROWS_JSON env var is required.')
  console.error('       See the header of this script for input shape.')
  process.exit(1)
}

interface InputRow {
  email:         string
  vehicle_plate: string
  vehicle_state: string
  vehicle_make:  string | null
  vehicle_model: string | null
  vehicle_color: string | null
}

let rows: InputRow[]
try {
  const parsed = JSON.parse(rowsRaw)
  if (!Array.isArray(parsed)) throw new Error('expected an array')
  rows = parsed.map((r: Record<string, unknown>) => ({
    email:         String(r.email ?? '').trim().toLowerCase(),
    vehicle_plate: String(r.vehicle_plate ?? '').trim().toUpperCase(),
    vehicle_state: String(r.vehicle_state ?? 'TX').trim().toUpperCase(),
    vehicle_make:  r.vehicle_make ? String(r.vehicle_make).trim() : null,
    vehicle_model: r.vehicle_model ? String(r.vehicle_model).trim() : null,
    vehicle_color: r.vehicle_color ? String(r.vehicle_color).trim() : null,
  }))
} catch (e) {
  console.error('ERROR parsing BACKFILL_ROWS_JSON:', (e as Error).message)
  process.exit(1)
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Outcome =
  | { email: string; status: 'pass'; detail: string }
  | { email: string; status: 'skip'; reason: string }
  | { email: string; status: 'error'; message: string }

async function main(): Promise<void> {
  console.log(`B203 backfill · ${execute ? '⚠️  LIVE MODE — writes will land' : 'DRY-RUN (no writes)'}`)
  console.log(`Project:  ${url}`)
  console.log(`Rows in:  ${rows.length}\n`)

  const outcomes: Outcome[] = []

  for (const row of rows) {
    if (!row.email || !row.vehicle_plate) {
      outcomes.push({ email: row.email || '<blank>', status: 'skip',
        reason: 'missing email or vehicle_plate in input' })
      continue
    }

    // 1. Look up the residents row for this email. Service-role; bypasses RLS.
    const { data: residentRows, error: resErr } = await admin
      .from('residents')
      .select('id, email, property, unit, company')
      .ilike('email', row.email)
    if (resErr) {
      outcomes.push({ email: row.email, status: 'error',
        message: `residents lookup: ${resErr.message}` })
      continue
    }
    if (!residentRows || residentRows.length === 0) {
      outcomes.push({ email: row.email, status: 'skip',
        reason: 'no residents row found (orphan email — not created by the bulk upload)' })
      continue
    }
    if (residentRows.length > 1) {
      outcomes.push({ email: row.email, status: 'skip',
        reason: `${residentRows.length} residents rows match; refusing to guess which scope to use` })
      continue
    }
    const resident = residentRows[0] as { id: number; email: string; property: string; unit: string; company: string }

    // 2. Check whether ANY vehicle already exists for (resident_email,
    //    property, unit). If yes — skip; another path created it.
    const { data: existing, error: exErr } = await admin
      .from('vehicles')
      .select('id, plate')
      .ilike('resident_email', resident.email)
      .ilike('property', resident.property)
      .ilike('unit', resident.unit)
    if (exErr) {
      outcomes.push({ email: row.email, status: 'error',
        message: `vehicles lookup: ${exErr.message}` })
      continue
    }
    if (existing && existing.length > 0) {
      outcomes.push({ email: row.email, status: 'skip',
        reason: `vehicle(s) already exist for this resident: ${existing.map(v => v.plate).join(', ')}` })
      continue
    }

    // 3. Build the insert payload — MIRRORS the post-B203 bulk-invite
    //    payload exactly. No company field; ownership scope via
    //    resident_email + (property, unit); status='active' +
    //    is_active=true matches the bulk-resident auto-approval semantic.
    const insertPayload = {
      plate:           row.vehicle_plate,
      state:           row.vehicle_state,
      make:            row.vehicle_make,
      model:           row.vehicle_model,
      color:           row.vehicle_color,
      resident_email:  resident.email.trim().toLowerCase(),
      property:        resident.property,
      unit:            resident.unit,
      status:          'active',
      is_active:       true,
    }

    if (!execute) {
      outcomes.push({ email: row.email, status: 'pass',
        detail: `DRY-RUN — would insert plate=${insertPayload.plate} state=${insertPayload.state} ` +
                `at (property="${insertPayload.property}", unit="${insertPayload.unit}")` })
      continue
    }

    // 4. LIVE insert.
    const { data: inserted, error: insErr } = await admin
      .from('vehicles')
      .insert([insertPayload])
      .select('id')
      .single()
    if (insErr || !inserted) {
      outcomes.push({ email: row.email, status: 'error',
        message: `vehicles insert: ${insErr?.message ?? 'no row returned'}` })
      continue
    }
    outcomes.push({ email: row.email, status: 'pass',
      detail: `inserted vehicle id=${inserted.id} plate=${insertPayload.plate}` })
  }

  // ── REPORT ──────────────────────────────────────────────────────────
  console.log('── PER-ROW OUTCOMES ──')
  for (const o of outcomes) {
    const tag = o.status === 'pass' ? '✓ PASS' :
                o.status === 'skip' ? '⊘ SKIP' :
                '✗ ERROR'
    const detail = o.status === 'pass' ? o.detail :
                   o.status === 'skip' ? o.reason :
                   o.message
    console.log(`  ${tag}  ${o.email}  →  ${detail}`)
  }

  const passCount  = outcomes.filter(o => o.status === 'pass').length
  const skipCount  = outcomes.filter(o => o.status === 'skip').length
  const errorCount = outcomes.filter(o => o.status === 'error').length
  console.log('\n── SUMMARY ──')
  console.log(`  ${execute ? 'inserts that landed' : 'inserts that WOULD land'}: ${passCount}`)
  console.log(`  skipped:                                     ${skipCount}`)
  console.log(`  errors:                                      ${errorCount}`)
  if (!execute) {
    console.log('\n  DRY-RUN finished. To execute, re-run with EXECUTE=1 prepended.')
  }
  process.exit(errorCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('UNHANDLED:', (e as Error).message)
  process.exit(1)
})

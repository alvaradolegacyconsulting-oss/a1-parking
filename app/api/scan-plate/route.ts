import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../lib/server-auth'
import { hasFeature } from '../../lib/tier'
import { FEATURE_FLAGS } from '../../lib/feature-flags'

// /api/scan-plate — Claude Vision plate-recognition endpoint.
//
// Gate ordering (cheapest-first per Jose's spec):
//   1. AUTH (no DB)         — getUser → 401 if unauthenticated
//   2. ROLE (one DB read)   — user_roles.role ∈ {driver, company_admin} else 403
//   3. PAYLOAD (no DB)      — image must be base64 string ≤ 2 MB else 400/413
//   4. ENTITLEMENT (DB)     — companies.tier resolves AI_PLATE_SCANNING via
//                             hasFeature() — Growth/Legacy/Premium only,
//                             Starter + all PM blocked → 403 with upgrade copy
//
// Why hasFeature (sync) inline instead of hasFeatureAsync: hasFeatureAsync
// uses the browser anon supabase client which doesn't carry server-side
// JWT cookies, so its companies SELECT would silently return null under
// the authenticated_read_own_company RLS policy. The cookies-aware server
// client (createSupabaseServerClient) does carry the JWT, so its companies
// SELECT respects RLS and resolves cleanly to the caller's own company row.
// We replicate hasFeatureAsync's tier+overrides resolution inline against
// the server client to keep the entitlement check accurate for proposal-
// code customers whose feature_overrides flip plate-scan back on.
//
// Out of scope for this commit (per the locked June-4 launch plan): the
// per-user rate limit + daily cost ceiling. Those need Vercel KV and ship
// as Scan-plate Commit 2.

const MAX_IMAGE_B64_BYTES = 2 * 1024 * 1024  // 2 MB base64 ≈ 1.5 MB raw JPEG.

const ALLOWED_ROLES = new Set(['driver', 'company_admin'])

export async function POST(request: NextRequest) {
  // ── 1. AUTH ──────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // ── 2. ROLE GATE ─────────────────────────────────────────────────
  // user_roles RLS permits self-read; the caller's row is always reachable.
  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .maybeSingle()
  if (roleErr || !roleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (!ALLOWED_ROLES.has(roleRow.role)) {
    // Field-enforcement action: only driver + company_admin are legitimate
    // callers (see app/driver/page.tsx:302 + app/company_admin/page.tsx:1164,
    // the only call sites in the codebase).
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // ── 3. PAYLOAD SHAPE + SIZE ──────────────────────────────────────
  // request.json() can throw on malformed JSON; catch and 400.
  const body = await request.json().catch(() => null) as { image?: unknown } | null
  if (!body || typeof body.image !== 'string') {
    return NextResponse.json({ error: 'image must be a base64 string' }, { status: 400 })
  }
  const image = body.image
  // Shape sanity: base64 alphabet plus padding. A camera-captured JPEG b64
  // starts with /9j/ (the SOI marker). We accept any base64 alphabet start
  // to keep the check permissive against future capture formats while still
  // rejecting obvious junk like form-encoded payloads or HTML.
  if (image.length === 0 || !/^[A-Za-z0-9+/]/.test(image)) {
    return NextResponse.json({ error: 'image is not valid base64' }, { status: 400 })
  }
  if (image.length > MAX_IMAGE_B64_BYTES) {
    return NextResponse.json({
      error: 'Image exceeds size limit. Please use a lower-resolution capture.',
    }, { status: 413 })
  }

  // ── 4. ENTITLEMENT (last; the DB hit) ────────────────────────────
  // Resolve caller's companyId + tier via own-company read (RLS-permitted
  // by authenticated_read_own_company at migrations/20260612_b155_3_...sql).
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('id, tier, tier_type')
    .ilike('name', roleRow.company ?? '')
    .maybeSingle()
  if (companyErr || !company) {
    return NextResponse.json({ error: 'company not found' }, { status: 403 })
  }

  // proposal_codes_summary may be RLS-readable by company_admin only; tolerate
  // null (driver caller may not have direct read; the feature_overrides path
  // is then skipped, falling through to the tier matrix — correct default
  // since plate-scan overrides are rare and Growth/Legacy entitle without
  // override anyway).
  const { data: pc } = await supabase
    .from('proposal_codes_summary')
    .select('feature_overrides')
    .eq('company_id', company.id)
    .eq('status', 'redeemed')
    .maybeSingle()

  const allowed = hasFeature(FEATURE_FLAGS.AI_PLATE_SCANNING, {
    tier: (company.tier as string) || 'legacy',
    tier_type: (company.tier_type as string) || 'enforcement',
    proposal_code: pc
      ? { feature_overrides: pc.feature_overrides as Record<string, boolean | number> }
      : null,
  })
  if (allowed !== true) {
    return NextResponse.json({
      error: 'AI plate scanning is not available on your current tier. Upgrade to Growth or Legacy to enable it.',
    }, { status: 403 })
  }

  // ── HANDLER BODY (unchanged from pre-gate route) ─────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Plate scanning not configured' }, { status: 500 })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: image },
          },
          {
            type: 'text',
            text: 'This is a photo of a vehicle license plate. Extract ONLY the license plate number/letters. Return ONLY the plate text with no spaces, no punctuation, no explanation. Just the alphanumeric characters on the plate.',
          },
        ],
      }],
    }),
  })

  const responseText = await response.text()
  let data: { content?: Array<{ text?: string }>; error?: { message?: string } }
  try {
    data = JSON.parse(responseText)
  } catch {
    return NextResponse.json({ error: 'Invalid response from API' }, { status: 500 })
  }

  if (!response.ok) {
    return NextResponse.json({ error: data.error?.message || 'API error' }, { status: 500 })
  }

  const plate = (data.content?.[0]?.text || '')
    .trim()
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 8)

  // B228 Phase 2 — metering for the Super-Admin Console cost section.
  // Append-only audit_logs INSERT in the success path; new_values
  // carries tool + company + email so the console aggregate fn can
  // group by company without an extra JOIN through user_roles.
  //
  // FUTURE VIN-LOOKUP HOOK (zero rework when attorney clears it):
  //   When the VIN-lookup endpoint ships, it uses the SAME shape:
  //     INSERT INTO audit_logs (action='API_USAGE_METER', new_values={
  //       tool: 'vin_lookup', company: <from caller>, email: <from caller>
  //     })
  //   The console's cost section aggregates by new_values.tool, so a
  //   new tool name appears automatically. No console code changes
  //   needed — just the new endpoint's INSERT.
  //
  // Soft-fail: a failed audit INSERT MUST NOT break the scan response.
  // The user got their plate; we lose one metering row at worst.
  await supabase.from('audit_logs').insert([{
    user_email: user.email,
    action:     'API_USAGE_METER',
    table_name: 'api_calls',
    new_values: {
      tool:    'plate_read',
      company: roleRow.company,
      email:   user.email,
      plate,
    },
  }]).then(({ error }) => {
    if (error) console.warn('[scan-plate metering] insert failed (non-fatal):', error.message)
  })

  return NextResponse.json({ plate })
}

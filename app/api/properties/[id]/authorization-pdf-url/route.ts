import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, requireAuthenticated } from '../../../../lib/server-auth'

// B51a — signed-URL endpoint for property-authorizations PDFs.
// Mirrors the proposal-pdfs route pattern: server-side role check
// before generating a short-lived signed URL. RLS on the bucket
// enforces the actual permission boundary; this endpoint additionally
// validates so we return a clean 403 instead of a 200-with-no-URL
// when access is denied.

export const runtime = 'nodejs'
export const maxDuration = 60

const SIGNED_URL_TTL_SECONDS = 3600

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticated()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id: idStr } = await ctx.params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  // SELECT runs under caller's RLS; if they can't see the property,
  // we get null and return 404 (don't leak existence).
  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('id, company, name, authorization_pdf_path')
    .eq('id', id)
    .single()
  if (propErr || !prop) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!prop.authorization_pdf_path) {
    return NextResponse.json({ error: 'no authorization pdf' }, { status: 404 })
  }

  // Role check belt-and-suspenders. RLS on properties already
  // gated the SELECT above, so reaching here means the user has
  // SELECT rights on the property. But we re-check explicitly to
  // keep the API contract clear and to match the proposal-pdfs
  // route's structure.
  let allowed = auth.role === 'admin'
  if (!allowed && auth.role === 'company_admin' && prop.company && auth.companyName) {
    if (prop.company.toLowerCase() === auth.companyName.toLowerCase()) allowed = true
  }
  if (!allowed && auth.role === 'manager') {
    // Manager reached this point only if the properties SELECT
    // succeeded under RLS — which means they're assigned to this
    // property. RLS is the source of truth; we trust it.
    allowed = true
  }
  if (!allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { data: signed, error: signErr } = await supabase
    .storage
    .from('property-authorizations')
    .createSignedUrl(prop.authorization_pdf_path, SIGNED_URL_TTL_SECONDS)
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: 'signed url generation failed: ' + (signErr?.message || 'unknown') },
      { status: 500 }
    )
  }

  return NextResponse.json({ url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS })
}

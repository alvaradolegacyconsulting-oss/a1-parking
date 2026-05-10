import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, requireAuthenticated } from '../../../../lib/server-auth'

export const runtime = 'nodejs'
export const maxDuration = 60

const SIGNED_URL_TTL_SECONDS = 3600

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticated()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id: idStr } = await ctx.params
  const id = Number(idStr)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const supabase = await createSupabaseServerClient()
  const { data: row, error: rowErr } = await supabase
    .from('proposal_codes')
    .select('id, status, pdf_url, company_id')
    .eq('id', id)
    .single()
  if (rowErr || !row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!row.pdf_url) return NextResponse.json({ error: 'pdf not generated yet' }, { status: 404 })

  // Authorization:
  //   admin: always allowed
  //   company_admin: only if proposal status='redeemed' AND its company
  //     matches the user's company (resolve via companies.name ILIKE).
  let allowed = auth.role === 'admin'
  if (!allowed && auth.role === 'company_admin' && row.status === 'redeemed' && row.company_id) {
    const { data: co } = await supabase
      .from('companies')
      .select('id')
      .ilike('name', auth.companyName || '')
      .single()
    if (co?.id === row.company_id) allowed = true
  }
  if (!allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { data: signed, error: signErr } = await supabase
    .storage
    .from('proposal-pdfs')
    .createSignedUrl(row.pdf_url as string, SIGNED_URL_TTL_SECONDS)
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: 'signed url generation failed: ' + (signErr?.message || 'unknown') }, { status: 500 })
  }

  return NextResponse.json({ url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS })
}

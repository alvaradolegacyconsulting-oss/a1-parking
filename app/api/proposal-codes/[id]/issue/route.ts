import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, requireAdmin } from '../../../../lib/server-auth'
import { generateProposalPdf } from '../../../../lib/proposal-pdf'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id: idStr } = await ctx.params
  const id = Number(idStr)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const supabase = await createSupabaseServerClient()

  const { data: row, error: rowErr } = await supabase
    .from('proposal_codes')
    .select('*')
    .eq('id', id)
    .single()
  if (rowErr || !row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (row.status !== 'draft') return NextResponse.json({ error: `cannot issue from status=${row.status}` }, { status: 409 })

  // Resolve platform logo URL (for embedding in PDF). Best-effort.
  let logoUrl: string | null = null
  try {
    const { data: ps } = await supabase.from('platform_settings').select('default_logo_url').eq('id', 1).single()
    if (ps?.default_logo_url) logoUrl = ps.default_logo_url as string
  } catch { /* ignore */ }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  let pdfBuffer: Buffer
  try {
    pdfBuffer = await generateProposalPdf(row, { logoUrl, appUrl })
  } catch (e) {
    return NextResponse.json({ error: 'pdf generation failed: ' + (e as Error).message }, { status: 500 })
  }

  const path = `proposals/${row.code}.pdf`
  const { error: upErr } = await supabase
    .storage
    .from('proposal-pdfs')
    .upload(path, pdfBuffer, { contentType: 'application/pdf', upsert: true })
  if (upErr) return NextResponse.json({ error: 'upload failed: ' + upErr.message }, { status: 500 })

  const { error: updErr } = await supabase
    .from('proposal_codes')
    .update({
      status: 'issued',
      pdf_url: path,
      issued_at: new Date().toISOString(),
      issued_by: auth.email,
    })
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: 'row update failed: ' + updErr.message }, { status: 500 })

  return NextResponse.json({ success: true, code: row.code, pdf_path: path })
}

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

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${row.code}-preview.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}

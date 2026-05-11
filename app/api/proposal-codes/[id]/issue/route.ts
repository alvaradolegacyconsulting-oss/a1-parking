import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, requireAdmin } from '../../../../lib/server-auth'

// Server-side Puppeteer PDF generation was attempted five times on
// Vercel (c7a6115 / 46ec4af / a661159 / 3524c8d and a bundled-binary
// variant) and consistently failed with libnss3.so load errors.
// Locked decision (May 13): hand-generate proposal PDFs until the
// Phase 2 web acceptance page lands. This endpoint now performs the
// status transition only; the PDF is uploaded manually per
// docs/hand-gen-pdf.md.
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
    .select('id, code, status')
    .eq('id', id)
    .single()
  if (rowErr || !row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (row.status !== 'draft') {
    return NextResponse.json({ error: `cannot issue from status=${row.status}` }, { status: 409 })
  }

  // Transition the status. pdf_url stays NULL until a PDF is manually
  // generated and uploaded — the View PDF button on the detail page
  // surfaces "PDF Pending" until that happens.
  const { error: updErr } = await supabase
    .from('proposal_codes')
    .update({
      status: 'issued',
      issued_at: new Date().toISOString(),
      issued_by: auth.email,
    })
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: 'row update failed: ' + updErr.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    code: row.code,
    pdf_pending: true,
    message: 'Code issued. PDF generation is currently manual — see docs/hand-gen-pdf.md to create and upload the PDF.',
  })
}

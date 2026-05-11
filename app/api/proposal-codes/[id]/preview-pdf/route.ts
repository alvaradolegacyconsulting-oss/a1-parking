import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '../../../../lib/server-auth'

// Preview rendering ran in-memory and never persisted anything; with
// hand-generation now the workflow, preview is replaced by the local
// render script at scripts/render-proposal.ts.
export const runtime = 'nodejs'

export async function POST(_req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  return NextResponse.json({
    error: 'PDF preview is temporarily manual. Run `npx tsx scripts/render-proposal.ts <CODE>` locally, then open the resulting HTML in your browser and Print → Save as PDF. See docs/hand-gen-pdf.md.',
    code: 'PDF_GENERATION_DISABLED',
  }, { status: 501 })
}

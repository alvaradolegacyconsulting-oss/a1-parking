// Local-only proposal PDF render helper.
//
// Usage:
//   export NEXT_PUBLIC_SUPABASE_URL=...
//   export SUPABASE_SERVICE_ROLE_KEY=...
//   export NEXT_PUBLIC_APP_URL=https://shieldmylot.com   # optional
//   npx tsx scripts/render-proposal.ts <CODE>
//
// Output: ./output/<CODE>.html  — open in Chrome, ⌘P, Save as PDF.
// See docs/hand-gen-pdf.md for the full workflow.

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderProposalPdfHtml, type ProposalForPdf } from '../app/lib/proposal-pdf-template'

async function main() {
  const code = process.argv[2]
  if (!code) {
    console.error('Usage: npx tsx scripts/render-proposal.ts <CODE>')
    process.exit(1)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  // Prefer service-role so we can read proposal_codes despite RLS.
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) in env.')
    process.exit(1)
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('⚠  No SUPABASE_SERVICE_ROLE_KEY set — falling back to anon key. proposal_codes lookup will likely fail because of RLS.')
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  const { data: row, error } = await supabase
    .from('proposal_codes')
    .select('*')
    .eq('code', code)
    .single()
  if (error || !row) {
    console.error(`proposal_codes lookup failed for code=${code}:`, error?.message || 'not found')
    process.exit(1)
  }

  let logoUrl: string | null = null
  const { data: ps } = await supabase
    .from('platform_settings')
    .select('default_logo_url')
    .eq('id', 1)
    .single()
  if (ps?.default_logo_url) logoUrl = ps.default_logo_url as string

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  const html = renderProposalPdfHtml(row as ProposalForPdf, { logoUrl, appUrl })

  const outDir = join(process.cwd(), 'output')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${code}.html`)
  writeFileSync(outPath, html, 'utf-8')

  const storagePath = `proposals/${code}.pdf`
  console.log(`Wrote ${outPath}`)
  console.log('')
  console.log('Next steps:')
  console.log(`  1. Open ${outPath} in Chrome.`)
  console.log('  2. ⌘P → Save as PDF (US Letter, default margins, background graphics ON).')
  console.log(`  3. Upload to Supabase Storage: bucket 'proposal-pdfs', path '${storagePath}'.`)
  console.log(`  4. UPDATE proposal_codes SET pdf_url = '${storagePath}' WHERE code = '${code}';`)
  console.log('  5. Reload /admin/proposal-codes/<CODE> → "PDF Pending" should now read "View PDF".')
}

main().catch(e => {
  console.error('render-proposal failed:', e)
  process.exit(1)
})

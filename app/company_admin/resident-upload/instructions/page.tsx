// ════════════════════════════════════════════════════════════════════
// The full resident-upload instructions, as a page a customer can read
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY THIS PAGE EXISTS. The copy it renders was approved on
// 2026-10-14 and then never shipped: it sat in docs/bulk-onboarding/
// INSTRUCTIONS.md, which nothing in app/ read, linked or rendered.
// Approved copy that no customer can reach is the same as no copy, and
// the upload page's "Full instructions" link had nowhere to point.
//
// Not in middleware's publicPaths, so it needs a session like every
// other /company_admin page. The audience is the CA's own staff, who
// have logins; the instructions name a property's residents only in the
// abstract, but there is no reason to hand an unauthenticated visitor
// the shape of the enforcement data either.
//
// No state, no effects, no inputs — a server component on purpose.

import Link from 'next/link'
import { INSTRUCTIONS } from '../../../lib/bulk-instructions'
import { BULK_CSV_HEADER, MAX_BULK_ROWS } from '../../../lib/bulk-onboarding'

const GOLD = '#C9A227'
const BG = '#0f1117'
const CARD_BG = '#161b26'
const BORDER = '#2a2f3d'
const TEXT = '#e2e8f0'
const MUTED = '#888'

export default function ResidentUploadInstructionsPage() {
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'Arial, sans-serif', padding: '40px 24px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <Link href="/company_admin/resident-upload" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>
          ← Back to the upload page
        </Link>
        <h1 style={{ color: GOLD, fontSize: 24, fontWeight: 800, margin: '8px 0 4px' }}>
          Resident upload — full instructions
        </h1>
        <p style={{ color: MUTED, fontSize: 13, margin: '0 0 4px' }}>
          Up to {MAX_BULK_ROWS.toLocaleString()} rows, one property per file.
        </p>

        <section style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, marginTop: 16 }}>
          {INSTRUCTIONS.map(p => (
            <p key={p.lead} style={{ fontSize: 14, lineHeight: 1.7, margin: '0 0 14px', color: TEXT }}>
              <strong style={{ color: GOLD }}>{p.lead}</strong>{p.text ? ' ' + p.text : ''}
            </p>
          ))}

          {/* The header is printed from the shared constant, never typed
              out here: a header in the instructions that disagrees with
              the one the route demands is a file that validates in the
              customer's spreadsheet and is refused on submission. */}
          <p style={{ fontSize: 13, color: MUTED, margin: '18px 0 6px' }}>The header row, exactly:</p>
          <pre style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '10px 12px',
                        fontSize: 12, color: TEXT, overflowX: 'auto', margin: 0 }}>
            {BULK_CSV_HEADER}
          </pre>
        </section>
      </div>
    </main>
  )
}

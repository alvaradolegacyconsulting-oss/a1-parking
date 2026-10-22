// ════════════════════════════════════════════════════════════════════
// GATE — the home page may not claim a capability that has no writer
// ════════════════════════════════════════════════════════════════════
//
// 🔴 The comparison table said "office-issued" visitor passes in all
// four columns. No plan had it: issue_visitor_pass has exactly two
// callers, the anonymous QR route and the resident portal. The table's
// own header says every cell was "checked against TIER_CONFIG" — and
// that was true, which is the lesson. VISITOR_PASS_MANAGEMENT is ON
// everywhere, so the flag supported the claim while the write path did
// not exist. A flag is a permission, not a feature.
//
// So this gate checks the claim against the WRITE PATH, and does it in
// both directions: the words may not appear while no writer exists, and
// if a writer ever lands, the gate says so rather than leaving the
// home page quietly understating a shipped feature.
//
// Usage: npx tsx scripts/verify-homepage-claims.ts

import fs from 'fs'
import { execFileSync } from 'child_process'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

console.log('\n══ home page claims vs write paths ══\n')

const table = fs.readFileSync('app/lib/tier-display.ts', 'utf8')
// Comments explain the removal and name the words, so strip them first
// or the gate fails on its own explanation.
const cells = table.replace(/\/\/[^\n]*/g, '')

/** Files that call issue_visitor_pass, excluding the two known callers. */
function officeWriters(): string[] {
  const out = execFileSync('git', ['grep', '-l', "rpc('issue_visitor_pass'", '--', 'app/'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  const KNOWN = ['app/api/visitor/create-pass/route.ts', 'app/resident/page.tsx']
  return out.filter(f => !KNOWN.includes(f))
}

const writers = officeWriters()
const claimsOffice = /office[- ]issued/i.test(cells)

chk('issue_visitor_pass still has only its two known callers', writers.length === 0,
  writers.length ? `🔴 new caller(s): ${writers.join(', ')} — if this is the office path, the home page row can say "office" again`
                 : 'QR route + resident portal, as expected')

if (writers.length === 0) {
  chk('🔴 the home page does NOT claim office-issued passes', !claimsOffice,
    claimsOffice ? '🔴 the words are back while no writer exists' : 'claim absent, matching the product')
} else {
  chk('the home page reflects the shipped office path', claimsOffice,
    claimsOffice ? 'claimed and implemented' : '⚠ a writer exists but the table still omits "office-issued" — update it')
}

// Operator Starter has no resident portal, so it cannot have
// resident-issued passes either. Pin that cell.
const osCell = /operatorStarter: '([^']*)'/.exec(
  cells.slice(cells.indexOf("capability: 'Visitor passes'")),
)?.[1] ?? ''
chk('Operator Starter’s visitor-pass cell claims neither office nor resident issuing',
  !/office/i.test(osCell) && !/resident/i.test(osCell), `cell reads: "${osCell}"`)

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
process.exit(fails ? 1 : 0)

// PM CRM Slice 7 Part A — de-bill manager CRM strip probe.
//
// Principle enforced: billing surfaces to company_admin ONLY. Managers,
// residents, drivers never see billed / metered / invoice / $ figures.
// This probe is a STATIC SOURCE-REGION SCAN — no DB, no auth. Slice 7
// Part A is a UI text change; the honest regression net is asserting
// the banned strings do not appear inside the strip's source region.
//
// Assertions:
//   [1] Positive leak-check — the Insights strip source region contains
//       NONE of: 'metered', 'billed', 'invoice'.
//   [2] Positive dollar-figure check — no literal '$' inside the strip
//       or subtitle region (excluding JS template-literal '${...}'
//       and code comments). Catches a future regression that
//       introduces a *price* rather than the word 'billed'.
//   [3] Pill snapshot — the "Approved permits" pill label is a plain
//       string, not a nested JSX expression carrying `metered*`.
//   [4] Subtitle snapshot — the footer div's inner text is
//       `Property: <b>{propertyName}</b>.` — no slice-progress
//       narrator, no metered footnote.
//   [5] Leak-check on siblings — resident/driver source files still
//       contain none of 'metered', 'billed', 'invoice' (Jose's
//       leak-check standing rule; guards against future regression on
//       the non-subscriber surfaces).
//
// Run: npx tsx scripts/probe-crm-slice7-de-bill.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const CRM_FILE = join(ROOT, 'app', 'components', 'PmResidentCrm.tsx')
const RES_FILE = join(ROOT, 'app', 'resident', 'page.tsx')
const DRV_FILE = join(ROOT, 'app', 'driver', 'page.tsx')

const BANNED_WORDS = ['metered', 'billed', 'invoice']

function stripCodeComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function findBannedWords(region: string, label: string): string[] {
  const hits: string[] = []
  const stripped = stripCodeComments(region).toLowerCase()
  for (const w of BANNED_WORDS) {
    if (stripped.includes(w)) hits.push(`${label} contains '${w}'`)
  }
  return hits
}

function findDollarFigure(region: string, label: string): string[] {
  const stripped = stripCodeComments(region)
  const hits: string[] = []
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '$' && stripped[i + 1] !== '{') {
      const ctx = stripped.slice(Math.max(0, i - 20), Math.min(stripped.length, i + 20))
      hits.push(`${label} has literal '$' at ctx="…${ctx.replace(/\n/g, ' ')}…"`)
    }
  }
  return hits
}

async function main() {
  console.log('══ SLICE 7 PART A DE-BILL PROBE (static source scan) ════════════')
  console.log('  no DB, no auth — asserts source regions carry no billing figures.\n')

  const crm = readFileSync(CRM_FILE, 'utf-8')

  // ── Bound the Insights strip region ─────────────────────────────
  // Anchors: opening comment `{/* ── Insights strip` and the next
  // comment `{/* ── CRM grid:`.
  const stripStart = crm.indexOf('/* ── Insights strip')
  const stripEnd = crm.indexOf('/* ── CRM grid:', stripStart)
  if (stripStart < 0 || stripEnd < 0) {
    console.log('  🔴 could not locate strip anchors — file structure changed')
    process.exit(2)
  }
  const stripRegion = crm.slice(stripStart, stripEnd)

  // ── Bound the subtitle (footer div under the CRM grid) ──────────
  // Anchor: the div with `maxWidth: '1300px'`.
  const subStart = crm.indexOf(`maxWidth: '1300px', margin: '18px auto 0'`)
  if (subStart < 0) {
    console.log('  🔴 could not locate subtitle anchor')
    process.exit(2)
  }
  // Walk back to the enclosing <div style={{
  const subDivOpen = crm.lastIndexOf('<div style={{', subStart)
  // Match its </div> by naive depth counting from subDivOpen.
  let depth = 0
  let subEnd = subDivOpen
  for (let i = subDivOpen; i < crm.length; i++) {
    if (crm.startsWith('<div', i)) depth++
    else if (crm.startsWith('</div>', i)) {
      depth--
      if (depth === 0) { subEnd = i + '</div>'.length; break }
    }
  }
  const subtitleRegion = crm.slice(subDivOpen, subEnd)

  // ── [1] Positive leak-check on strip ─────────────────────────────
  console.log('─── [1] Insights strip — no metered/billed/invoice ──────────')
  const wordHits1 = findBannedWords(stripRegion, 'strip')
  const test1 = wordHits1.length === 0
  if (!test1) wordHits1.forEach(h => console.log(`  🔴 ${h}`))
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] Positive dollar-figure check ────────────────────────────
  console.log('─── [2] Strip + subtitle — no literal $ (excludes ${...}) ───')
  const dollarStrip = findDollarFigure(stripRegion, 'strip')
  const dollarSub = findDollarFigure(subtitleRegion, 'subtitle')
  const dollarHits = [...dollarStrip, ...dollarSub]
  const test2 = dollarHits.length === 0
  if (!test2) dollarHits.forEach(h => console.log(`  🔴 ${h}`))
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Pill snapshot ─────────────────────────────────────────────
  console.log('─── [3] Snapshot — pill label is plain string ───────────────')
  // Expect the InsightCard for approvedPermits to carry label="Approved permits"
  // Match a compact block that includes both the counter binding and the label.
  const pillOk = /n=\{insights\.approvedPermits\}\s*\n\s*label="Approved permits"/.test(stripRegion)
  const test3 = pillOk
  if (!test3) {
    console.log(`  🔴 expected label="Approved permits" adjacent to n={insights.approvedPermits}`)
    console.log(`     found: ${stripRegion.match(/n=\{insights\.approvedPermits\}[\s\S]{0,200}/)?.[0] ?? '<no match>'}`)
  }
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Subtitle snapshot ────────────────────────────────────────
  console.log('─── [4] Snapshot — subtitle is `Property: <b>{name}</b>.` ───')
  // Subtitle region should contain ONLY the property line — no slice-
  // progress narrator, no metered footnote.
  const subtitleOk = /Property:\s*<b>\{propertyName\}<\/b>\.\s*<\/div>/.test(subtitleRegion)
  // Also assert the slice narrator string is gone
  const noNarrator = !/Slice \d+ shipped/i.test(subtitleRegion)
  const test4 = subtitleOk && noNarrator
  if (!subtitleOk) console.log(`  🔴 subtitle does not match "Property: <b>{propertyName}</b>."`)
  if (!noNarrator) console.log(`  🔴 subtitle still contains a 'Slice N shipped' narrator`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] Leak-check on resident + driver ──────────────────────────
  console.log('─── [5] Resident + driver source — no billing words ─────────')
  const res = readFileSync(RES_FILE, 'utf-8')
  const drv = readFileSync(DRV_FILE, 'utf-8')
  // Strip code comments (so incidental "$0.00 print" in a JSDoc note doesn't fail)
  const resHits = findBannedWords(res, 'resident/page.tsx')
  const drvHits = findBannedWords(drv, 'driver/page.tsx')
  const allHits5 = [...resHits, ...drvHits]
  const test5 = allHits5.length === 0
  if (!test5) allHits5.forEach(h => console.log(`  🔴 ${h}`))
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test1 && test2 && test3 && test4 && test5
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] strip no billing words: ${test1 ? '🟢' : '🔴'}  [2] no $ figure: ${test2 ? '🟢' : '🔴'}  [3] pill snapshot: ${test3 ? '🟢' : '🔴'}  [4] subtitle snapshot: ${test4 ? '🟢' : '🔴'}  [5] res/drv clean: ${test5 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

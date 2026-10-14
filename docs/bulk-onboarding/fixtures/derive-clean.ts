// Derives alden_fixture_clean.csv from alden_fixture_dirty.csv by
// applying exactly the fixes the architect documented, so the pair
// cannot drift and every difference between them is accounted for.
//
// Run: npx tsx docs/bulk-onboarding/fixtures/derive-clean.ts
//
// 🔴 The fixtures are the architect's ANONYMIZED derivative of A1's
// real Alden Park Kingsland export. The raw file is never committed.
// Names, emails, phones and plates are all replaced; units, make and
// model are kept because they carry the real format defects, which is
// the entire point of the fixture.

import fs from 'fs'

const DIR = 'docs/bulk-onboarding/fixtures'
const lines = fs.readFileSync(`${DIR}/alden_fixture_dirty.csv`, 'utf8').replace(/\n$/, '').split('\n')

// Spreadsheet row numbers (header = 1), as the expectations table uses.
const DROP = new Set([
  133,  // 3314 / plate HMD — incomplete plate
  355,  // 10301 / FLK0888 — the plate that appears on two units
])
const FIX: Record<number, [string, string]> = {
  7:   ['Apt 1104,', '1104,'],                    // unit noise word
  11:  ['Quimby,,', 'Quimby,resident007@example.com,'],  // blank email
  79:  [',Texas,', ',TX,'],
  167: [',Texas,', ',TX,'],
  204: [',Texas,', ',TX,'],
  328: ['#7201,', '7201,'],
  329: ['#1105,', '1105,'],
  360: ['3-3302,', '3302,'],
  361: ['3-3302,', '3302,'],
}

const out: string[] = []
for (let i = 0; i < lines.length; i++) {
  const rowNo = i + 1
  if (DROP.has(rowNo)) continue
  let line = lines[i]
  const fix = FIX[rowNo]
  if (fix) {
    if (!line.includes(fix[0])) throw new Error(`row ${rowNo}: expected ${JSON.stringify(fix[0])} in ${JSON.stringify(line.slice(0, 60))}`)
    line = line.replace(fix[0], fix[1])
  }
  out.push(line)
}

fs.writeFileSync(`${DIR}/alden_fixture_clean.csv`, out.join('\n') + '\n')

// The architect's stated counts are the check on the derivation.
const data = out.slice(1)
const households = new Set(data.map(l => {
  const c = l.split(',')
  return `${c[3].trim().toLowerCase()}\u0000${c[0].trim()}`
}))
console.log(`wrote alden_fixture_clean.csv — ${data.length} data rows, ${households.size} residents`)
if (data.length !== 358) throw new Error(`expected 358 data rows, got ${data.length}`)
if (households.size !== 228) throw new Error(`expected 228 residents (email+unit), got ${households.size}`)
console.log('✅ matches the architect\'s stated 358 vehicles / 228 residents')

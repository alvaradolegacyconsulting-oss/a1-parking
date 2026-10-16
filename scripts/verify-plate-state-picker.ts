// ════════════════════════════════════════════════════════════════════
// GATE — one plate-state vocabulary, rendered by one component
// ════════════════════════════════════════════════════════════════════
//
// THE HISTORY THIS EXISTS FOR. The product once had FOUR plate-state
// vocabularies (see app/lib/us-states.ts). They were consolidated into
// PLATE_STATES + PlateStateSelect, and the consolidation was incomplete
// in a way nobody could see: resident/page.tsx used PlateStateSelect
// for the ADD form and kept a 50-code array of its own, missing DC, for
// the EDIT form three hundred lines below. Same file, same field, two
// vocabularies.
//
// 🔴 WHY A STRAY ARRAY IS A DEFECT AND NOT A STYLE POINT. A <select>
// whose value matches no <option> cannot show that value. The resident
// opens a vehicle whose state is DC — or MX, as of 2026-10-16 — and
// sees an empty State box on a vehicle that has one; touching the field
// then writes something else. PlateStateSelect exists precisely to make
// that impossible, by rendering an unknown stored value as a selected
// option labelled "(as recorded)". A second array in the same codebase
// is a surface where that protection silently does not apply.
//
// 🔴 WHAT THIS CANNOT PROVE. It does not render anything. It cannot
// show that the select preserves an odd value — that needs a
// reconciler, and no render-test toolchain is installed (the same wall
// verify-crm-remount-keys.ts hit). It asserts the two things that are
// statically true or false: no second vocabulary exists, and every
// surface that had a picker still has one.
//
// Usage: npm run verify:platestatepicker

import fs from 'fs'
import path from 'path'
import { PLATE_STATES } from '../app/lib/us-states'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

/** The one file allowed to hold the list, with the reason. */
const THE_SOURCE = 'app/lib/us-states.ts'

/**
 * Surfaces that render a plate-state picker. Listed, so a surface that
 * silently stops using the shared component fails rather than quietly
 * growing its own options again.
 */
const PICKER_SURFACES = [
  'app/resident/page.tsx',
  'app/manager/page.tsx',
  'app/company_admin/page.tsx',
  'app/register/page.tsx',
  'app/components/AddVehicleForResidentModal.tsx',
]

function stripComments(src: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = ''
    let i = 0
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i)
        if (end === -1) { i = raw.length } else { inBlock = false; i = end + 2 }
        continue
      }
      if (raw.startsWith('//', i)) break
      if (raw.startsWith('/*', i)) { inBlock = true; i += 2; continue }
      line += raw[i]; i += 1
    }
    out.push(line)
  }
  return out
}

function tsFiles(dir: string): string[] {
  const found: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') found.push(...tsFiles(p)) }
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) found.push(p)
  }
  return found.sort()
}

/**
 * A hardcoded state vocabulary: a line holding several quoted
 * two-letter plate codes as ARRAY ELEMENTS. Five is the threshold — a
 * pair like ('TX','CA') in a fixture is not a vocabulary, a run of
 * fifty is.
 *
 * 🔴 ARRAY ELEMENTS, NOT ANY OCCURRENCE. Written as "any line with
 * five codes on it" this fired on bulk-validator's STATE_NAMES, the
 * spelled-out-name → code lookup ("alabama: 'AL', alaska: 'AK', …")
 * that exists to turn "Texas" into advice to write TX. That map is not
 * a list of options: nothing renders it, so it cannot produce the
 * empty-select defect this gate is about. A code preceded by ':' is an
 * object VALUE and is skipped. The control below asserts that
 * carve-out, so it stays a decision rather than becoming a hole.
 */
const MIN_CODES = 5
function stateArrayHits(lines: string[]): { line: number; count: number; text: string }[] {
  const hits: { line: number; count: number; text: string }[] = []
  lines.forEach((l, i) => {
    const codes = new Set<string>()
    for (const m of l.matchAll(/['"]([A-Z]{2})['"]/g)) {
      if (!PLATE_STATES.includes(m[1])) continue
      const before = l.slice(0, m.index).trimEnd()
      if (before.endsWith(':')) continue  // object value, e.g. alabama: 'AL'
      codes.add(m[1])
    }
    if (codes.size >= MIN_CODES) hits.push({ line: i + 1, count: codes.size, text: l.trim().slice(0, 90) })
  })
  return hits
}

function main() {
  console.log('\n══ one plate-state vocabulary, one picker ══\n')

  // ── controls first ───────────────────────────────────────────────
  const planted = stateArrayHits([`  const opts = ['TX','CA','FL','NY','GA','OH']`])
  chk('🔴 control: the detector finds a planted state array',
    planted.length === 1 && planted[0].count === 6,
    planted.length === 1 ? `${planted[0].count} codes` : '🔴 the detector is blind; a clean sweep would mean nothing')

  const innocent = stateArrayHits([
    `  const pair = ['TX','CA']`,
    `  if (x === 'TX') return`,
    `  const words = ['OK','NO','HI']`,
  ])
  chk('   ...and does not fire on a pair, a comparison, or stray two-letter words',
    innocent.length === 0,
    innocent.length === 0 ? `threshold is ${MIN_CODES} distinct real codes on one line` : `🔴 fired on ${innocent.map(h => h.text).join(' | ')}`)

  const nameMap = stateArrayHits([
    `  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',`,
  ])
  chk('   ...and not on the spelled-out-name lookup, which renders nowhere',
    nameMap.length === 0,
    nameMap.length === 0
      ? "a code after ':' is an object value, not an option — STATE_NAMES turns \"Texas\" into advice"
      : `🔴 fired on ${nameMap[0].text}`)

  chk('   ...and a commented-out array cannot fail the gate that documents it',
    stateArrayHits(stripComments(`// const states = ['TX','AL','AK','AZ','AR','CA']\nconst a = 1`)).length === 0,
    'comments blanked before matching')

  // ── no second vocabulary ─────────────────────────────────────────
  const files = tsFiles('app').filter(f => f !== THE_SOURCE)
  const strays = files.flatMap(f =>
    stateArrayHits(stripComments(fs.readFileSync(f, 'utf8'))).map(h => ({ file: f, ...h })))

  chk('the sweep read the app tree', files.length > 50, `${files.length} file(s), excluding ${THE_SOURCE}`)

  chk('🔴 no file outside us-states.ts carries its own state vocabulary',
    strays.length === 0,
    strays.length === 0
      ? `one list, ${PLATE_STATES.length} codes`
      : strays.map(h => `${h.file}:${h.line}  ${h.count} codes  — ${h.text}`).join('\n       '))

  // ── and the source still holds what it should ────────────────────
  chk('   ...and that list still carries DC and MX, the two a stray array lacked',
    PLATE_STATES.includes('DC') && PLATE_STATES.includes('MX'),
    `${PLATE_STATES.length} codes: DC=${PLATE_STATES.includes('DC')} MX=${PLATE_STATES.includes('MX')}`)

  // ── every picker surface still uses the component ────────────────
  const missing = PICKER_SURFACES.filter(f =>
    !stripComments(fs.readFileSync(f, 'utf8')).some(l => l.includes('<PlateStateSelect')))
  chk('🔴 every listed surface renders PlateStateSelect',
    missing.length === 0,
    missing.length === 0
      ? PICKER_SURFACES.map(f => path.basename(f)).join(' · ')
      : `🔴 no longer renders it: ${missing.join(', ')}`)

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

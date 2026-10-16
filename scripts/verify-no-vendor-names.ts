// ════════════════════════════════════════════════════════════════════
// GATE — no competitor or vendor name in customer-facing copy
// ════════════════════════════════════════════════════════════════════
//
// THE COPY THIS EXISTS FOR (2026-10-16). A checklist bullet on the
// resident-upload page read "your ParkingSnap export does not include
// it". Naming a competitor in our own onboarding copy dates the
// sentence, is wrong for every customer who came from something else
// or typed their list by hand, and reads as though we integrate with
// them. The rule is now: copy says what the data must CONTAIN, never
// where it came from.
//
// 🔴 INTERNAL NAMES ARE NOT COPY, AND THE DIFFERENCE IS THE WHOLE
// GATE. Towbook was de-branded on user-facing surfaces in June 2026
// while FEATURE_FLAGS.TOWBOOK_CSV_EXPORT and exportTowbook() were
// deliberately kept, to avoid churn in a flag that is read from the
// database. A gate that greps for the word would fire on that decision
// every run until someone silenced it, and a silenced gate protects
// nothing. So a hit only counts when the name stands ALONE — no
// identifier character on either side. 'exportTowbook' and
// 'towbook_csv_export' are identifiers; 'from Towbook' is copy.
//
// 🔴 COMMENTS ARE STRIPPED FIRST, for the reason this project has hit
// three times: a comment explaining which vendor name was removed
// contains that vendor name, and the explanation would fail the gate it
// is explaining.
//
// 🔴 AND IT CARRIES ITS OWN CONTROLS. A detector that silently stops
// matching reports a clean tree forever. Every run proves the detector
// finds a planted name in copy position AND leaves an identifier
// alone, before it is trusted on the real files.
//
// Usage: npm run verify:novendornames

import fs from 'fs'
import path from 'path'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

// Parking, towing and property-management software we might be compared
// to or migrated from. Add to this list; do not add exceptions to it.
const VENDORS = [
  'ParkingSnap', 'Parking Snap', 'ParkMobile', 'PassportParking', 'Passport Parking',
  'FlashParking', 'SpotHero', 'ParkHub', 'T2 Systems', 'gtechna', 'PayByPhone',
  'Metropolis', 'SP\\+', 'LAZ Parking', 'Premium Parking', 'Reef Parking',
  'Towbook', 'TRAXERO', 'Tracker Management', 'Beacon Software', 'Dispatch Anywhere',
  'AppFolio', 'Yardi', 'RealPage', 'Entrata', 'Buildium', 'SmartRent', 'Rent Manager',
]

/** Blank comment bodies, keep the line count so reports cite real lines. */
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

type Hit = { file: string; line: number; vendor: string; text: string }

/**
 * A vendor name counts only when it stands alone. The guards are
 * explicit rather than \b, because \b treats '_' as a word character
 * on one side and not the other, which is exactly the TOWBOOK_CSV
 * case.
 */
function scanText(file: string, lines: string[]): Hit[] {
  const hits: Hit[] = []
  lines.forEach((l, i) => {
    for (const v of VENDORS) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])(${v})([^A-Za-z0-9_]|$)`, 'i')
      const m = re.exec(l)
      if (m) hits.push({ file, line: i + 1, vendor: m[2], text: l.trim().slice(0, 110) })
    }
  })
  return hits
}

function filesUnder(dir: string, exts: string[]): string[] {
  const found: string[] = []
  if (!fs.existsSync(dir)) return found
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') found.push(...filesUnder(p, exts)) }
    else if (exts.some(x => e.name.endsWith(x))) found.push(p)
  }
  return found.sort()
}

function main() {
  console.log('\n══ no vendor names in customer-facing copy ══\n')

  // ── the controls, before the real files ──────────────────────────
  const planted = scanText('control', ['const msg = "Export it from Towbook and upload."'])
  chk('🔴 control: the detector finds a vendor name in copy position',
    planted.length === 1 && planted[0].vendor.toLowerCase() === 'towbook',
    planted.length === 1 ? 'found it' : `🔴 detector found ${planted.length} — it would report a clean tree either way`)

  const identifiers = scanText('control', [
    '  TOWBOOK_CSV_EXPORT: \'towbook_csv_export\',',
    '  function exportTowbook() {',
    '  hasFeature(FEATURE_FLAGS.TOWBOOK_CSV_EXPORT, ctx)',
  ])
  chk('   ...and leaves internal identifiers alone (the June 2026 decision)',
    identifiers.length === 0,
    identifiers.length === 0 ? 'TOWBOOK_CSV_EXPORT · towbook_csv_export · exportTowbook' : `🔴 would fire on ${identifiers.map(h => h.text).join(' | ')}`)

  const stripped = stripComments('// we removed ParkingSnap from this bullet\nconst a = 1')
  chk('   ...and a comment naming a vendor cannot fail the gate explaining it',
    scanText('control', stripped).length === 0,
    'comments blanked before matching')

  // ── the real surfaces ───────────────────────────────────────────
  const surfaces = [
    ...filesUnder('app', ['.ts', '.tsx']),
    'docs/bulk-onboarding/template.csv',
  ].filter(f => fs.existsSync(f))

  const hits = surfaces.flatMap(f => {
    const raw = fs.readFileSync(f, 'utf8')
    return scanText(f, f.endsWith('.csv') ? raw.split('\n') : stripComments(raw))
  })

  // 🔴 State the population. A sweep that read nothing is not a clean
  // sweep, and this one filters its own file list.
  chk('the sweep read the customer-facing tree', surfaces.length > 50,
    `${surfaces.length} file(s): all of app/ plus the template`)

  chk('🔴 no vendor name appears in customer-facing copy',
    hits.length === 0,
    hits.length === 0
      ? `${VENDORS.length} vendor name(s) searched for, none present`
      : hits.map(h => `${h.file}:${h.line}  "${h.vendor}"  — ${h.text}`).join('\n       '))

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

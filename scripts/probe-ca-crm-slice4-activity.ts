// CA CRM Slice 4 — Activity CRM static-source-region probe.
//
// Slice 4 layers 2 new filter dimensions (property × driver) on top of
// the existing time × status × search chain in the Violations tab.
// Behind CA_CRM_REDESIGN. No schema change; no new mutation. All
// existing controls (regenerate / void / view ticket / manage media /
// export) remain wired verbatim.
//
// Void handling is orthogonal per Gate 4 lock — `violations.voided_at`
// timestamp is the terminal-state overlay; `status` CHECK constraint
// unchanged. Slice 4 renders the voided-badge (existing) and does NOT
// add a "Void" enum option to the status dropdown.
//
// Assertions:
//   [0] Scaffolding — crmActivityPropertyFilter + crmActivityDriverFilter
//       state declared with default '' (all).
//   [1] filteredViolations() extended with the two new predicates ANDed
//       into the existing chain. Empty-state = no-op (default behavior
//       preserved).
//   [2] Slice 4 render inside `activeTab === 'violations' && CA_CRM_REDESIGN`
//       exposes the two dropdowns + a Clear button (visible only when
//       either filter is set).
//   [3] Property + driver options sourced client-side from the violations
//       list itself — NO new fetch (Array.from(new Set(violations.map(...)))).
//   [4] Existing status filter strip preserved — voided-only-in-'all' rule
//       intact in filteredViolations().
//   [5] No new mutation in the Slice 4 region — no supabase.from().update()
//       or .delete() or .insert() introduced (all controls are re-uses).
//   [6] No new "void" status option in STATUS_OPTIONS enum (void stays
//       orthogonal — signaled by voided_at, not by status='void').
//   [7] No billing/`$` phrasing in the Slice 4 filter region.
//
// Run: npx tsx scripts/probe-ca-crm-slice4-activity.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FILE = join(ROOT, 'app', 'company_admin', 'page.tsx')

function stripCodeComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function main() {
  console.log('══ CA CRM SLICE 4 ACTIVITY PROBE ════════════════════════════════')
  console.log('  Static source scan — no DB, no auth.\n')

  const src = readFileSync(FILE, 'utf-8')

  // ── Bound the Slice 4 filter-addition region ─────────────────────
  const regionStart = src.indexOf('CA CRM Slice 4 — Activity CRM')
  const regionEnd = src.indexOf('<input value={violationSearch}', regionStart)
  if (regionStart < 0 || regionEnd < 0) {
    console.log('  🔴 could not locate Slice 4 region anchors')
    process.exit(2)
  }
  const region = src.slice(regionStart, regionEnd)
  const regionClean = stripCodeComments(region)

  // Also bound filteredViolations for [1] and [4].
  const fvStart = src.indexOf('function filteredViolations()')
  const fvEnd = src.indexOf('function escapeCsv', fvStart)
  const fvRegion = fvStart >= 0 && fvEnd >= 0 ? src.slice(fvStart, fvEnd) : ''

  // ── [0] Scaffolding ────────────────────────────────────────────────
  console.log('─── [0] SCAFFOLDING (2 filter states, default all) ──────────')
  const propState = /const\s+\[crmActivityPropertyFilter,\s*setCrmActivityPropertyFilter\]\s*=\s*useState<string>\(''\)/.test(src)
  const driverState = /const\s+\[crmActivityDriverFilter,\s*setCrmActivityDriverFilter\]\s*=\s*useState<string>\(''\)/.test(src)
  const test0 = propState && driverState
  console.log(`  property filter state: ${propState ? '🟢' : '🔴'}  driver filter state: ${driverState ? '🟢' : '🔴'}`)
  console.log(`  [0] ${test0 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [1] filteredViolations extended (ANDed, no-op default) ───────
  console.log('─── [1] filteredViolations() ANDs new predicates ────────────')
  const propPredicate = /if\s*\(crmActivityPropertyFilter\s*&&\s*String\(v\.property[^)]*\)\.toLowerCase\(\)\s*!==\s*crmActivityPropertyFilter\.toLowerCase\(\)\)\s*return false/.test(fvRegion)
  const driverPredicate = /if\s*\(crmActivityDriverFilter\s*&&\s*String\(v\.driver_name[^)]*\)\.toLowerCase\(\)\s*!==\s*crmActivityDriverFilter\.toLowerCase\(\)\)\s*return false/.test(fvRegion)
  const test1 = propPredicate && driverPredicate
  console.log(`  property predicate: ${propPredicate ? '🟢' : '🔴'}  driver predicate: ${driverPredicate ? '🟢' : '🔴'}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] Slice 4 render — 2 dropdowns + Clear ─────────────────────
  console.log('─── [2] Slice 4 dropdowns + Clear button behind flag ────────')
  const flagGated = /\{CA_CRM_REDESIGN\s*&&\s*\(\(\)\s*=>/.test(region)
  const propDropdown = /<option value="">All properties<\/option>/.test(region)
  const driverDropdown = /<option value="">All drivers<\/option>/.test(region)
  const clearBtn = /Clear/.test(region) && /setCrmActivityPropertyFilter\(''\)/.test(region) && /setCrmActivityDriverFilter\(''\)/.test(region)
  const test2 = flagGated && propDropdown && driverDropdown && clearBtn
  console.log(`  behind CA_CRM_REDESIGN: ${flagGated ? '🟢' : '🔴'}  property dropdown: ${propDropdown ? '🟢' : '🔴'}  driver dropdown: ${driverDropdown ? '🟢' : '🔴'}  Clear btn: ${clearBtn ? '🟢' : '🔴'}`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Options client-side derived — NO new fetch ───────────────
  console.log('─── [3] Options derived from `violations` state (no fetch) ──')
  const propOpts = /Array\.from\(new Set\(\s*violations\.map\(\(v:\s*any\)\s*=>\s*String\(v\.property[^)]*\)\.trim\(\)\)\.filter\(Boolean\)\s*\)\)/.test(region)
  const driverOpts = /Array\.from\(new Set\(\s*violations\.map\(\(v:\s*any\)\s*=>\s*String\(v\.driver_name[^)]*\)\.trim\(\)\)\.filter\(Boolean\)\s*\)\)/.test(region)
  const noSupabaseFetch = !/supabase\.from\(/.test(region)
  const test3 = propOpts && driverOpts && noSupabaseFetch
  console.log(`  property opts derived: ${propOpts ? '🟢' : '🔴'}  driver opts derived: ${driverOpts ? '🟢' : '🔴'}  no supabase.from in region: ${noSupabaseFetch ? '🟢' : '🔴'}`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Voided-only-in-'all' preserved ───────────────────────────
  console.log('─── [4] Voided-only-in-\'all\' rule preserved (Gate 4 lock) ───')
  // Existing predicate check: 'open' branch drops voided rows.
  const openBranchDropsVoided = /violationStatusFilter\s*===\s*'open'[\s\S]{0,200}isVoided/.test(fvRegion)
  // No status='void' option was introduced.
  const noVoidStatusOption = !/status:\s*'void'/.test(src) && !/value:\s*'void'/.test(src)
  const test4 = openBranchDropsVoided && noVoidStatusOption
  console.log(`  'open' branch drops voided: ${openBranchDropsVoided ? '🟢' : '🔴'}  no 'void' status option: ${noVoidStatusOption ? '🟢' : '🔴'}`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] No new mutation in Slice 4 region ────────────────────────
  console.log('─── [5] No new supabase mutation in Slice 4 region ──────────')
  const newMutation = /supabase\.from\([^)]+\)[\s\S]{0,80}\.(insert|update|delete)\(/.test(region)
  const test5 = !newMutation
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [6] STATUS_OPTIONS enum unchanged ────────────────────────────
  console.log('─── [6] STATUS_OPTIONS carries no \'void\' value ─────────────')
  const statusOptionsRegion = src.match(/const STATUS_OPTIONS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const carriesVoid = /value:\s*['"]void['"]/.test(statusOptionsRegion)
  const test6 = !carriesVoid
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL — STATUS_OPTIONS contains void'}\n`)

  // ── [7] No billing/$ phrasing in filter region ───────────────────
  console.log('─── [7] No metered/billed/invoice/$ in Slice 4 filter region ─')
  const banned = ['metered', 'billed', 'invoice']
  const cleanLower = regionClean.toLowerCase()
  const wordHits = banned.filter(w => cleanLower.includes(w))
  let dollarHit = false
  for (let i = 0; i < regionClean.length; i++) {
    if (regionClean[i] === '$' && regionClean[i+1] !== '{') { dollarHit = true; break }
  }
  const test7 = wordHits.length === 0 && !dollarHit
  if (wordHits.length) console.log(`  🔴 banned words: ${wordHits.join(', ')}`)
  if (dollarHit) console.log(`  🔴 literal $ found (not \${...} template)`)
  console.log(`  [7] ${test7 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test0 && test1 && test2 && test3 && test4 && test5 && test6 && test7
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[0] scaffold: ${test0 ? '🟢' : '🔴'}  [1] filter extended: ${test1 ? '🟢' : '🔴'}  [2] dropdowns+clear: ${test2 ? '🟢' : '🔴'}  [3] no-fetch opts: ${test3 ? '🟢' : '🔴'}  [4] voided rule: ${test4 ? '🟢' : '🔴'}  [5] no new mutation: ${test5 ? '🟢' : '🔴'}  [6] no void enum: ${test6 ? '🟢' : '🔴'}  [7] no billing/$: ${test7 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

// CA CRM — Active-only carry-over probe.
//
// Pre-flag-flip parity commit: adds Active-only toggles to Slice 2
// (Properties CRM) and Slice 3 (People) so the redesign matches the
// legacy portal's default hide-deactivated behavior. Per-section state
// per architect — Properties toggle does NOT flip People (matches
// legacy per-tab behavior).
//
// Assertions:
//   [0] Scaffolding — crmPropertiesShowActive + crmPeopleShowActive
//       state declared with default = true (matches legacy pill).
//   [1] Properties CRM applies the filter — filter chain contains
//       `crmPropertiesShowActive ? p.is_active : true`.
//   [2] People applies the filter to ALL three groups (managers,
//       leasing agents, drivers).
//   [3] Toggle affordance present in each CRM branch.
//   [4] Per-section — two independent states, NOT one shared flag
//       (the two setters must be distinct).
//
// Run: npx tsx scripts/probe-ca-crm-active-only.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FILE = join(ROOT, 'app', 'company_admin', 'page.tsx')

async function main() {
  console.log('══ CA CRM ACTIVE-ONLY CARRY-OVER PROBE ══════════════════════════')
  console.log('  Static source scan.\n')

  const src = readFileSync(FILE, 'utf-8')

  // ── Bound the two Slice regions ──────────────────────────────────
  const s2Start = src.indexOf('SECTION 1 — Properties (CA CRM Slice 2)')
  const s2End = src.indexOf('SECTION 1 (LEGACY)', s2Start)
  const s3Start = src.indexOf('SECTION 2 (CA CRM Slice 3)')
  const s3End = src.indexOf('SECTION 2 (LEGACY)', s3Start)
  if (s2Start < 0 || s2End < 0 || s3Start < 0 || s3End < 0) {
    console.log('  🔴 could not locate slice regions')
    process.exit(2)
  }
  const s2Region = src.slice(s2Start, s2End)
  const s3Region = src.slice(s3Start, s3End)

  // ── [0] Scaffolding: two state hooks, both default true ──────────
  console.log('─── [0] SCAFFOLDING (2 states, both default true) ───────────')
  const propState = /const\s+\[crmPropertiesShowActive,\s*setCrmPropertiesShowActive\]\s*=\s*useState<boolean>\(true\)/.test(src)
  const peopleState = /const\s+\[crmPeopleShowActive,\s*setCrmPeopleShowActive\]\s*=\s*useState<boolean>\(true\)/.test(src)
  const test0 = propState && peopleState
  console.log(`  crmPropertiesShowActive (default true): ${propState ? '🟢' : '🔴'}  crmPeopleShowActive (default true): ${peopleState ? '🟢' : '🔴'}`)
  console.log(`  [0] ${test0 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [1] Properties filter applies crmPropertiesShowActive ────────
  console.log('─── [1] Properties CRM applies active-only filter ───────────')
  const propFilter = /crmPropertiesShowActive\s*\?\s*p\.is_active\s*:\s*true/.test(s2Region)
  const test1 = propFilter
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] People applies crmPeopleShowActive to all 3 groups ───────
  console.log('─── [2] People applies filter to all 3 groups ───────────────')
  // Managers + leasing_agents check u.is_active !== false; drivers check d.is_active !== false.
  const mgrFilter = /crmPeopleShowActive\s*\?\s*u\.is_active\s*!==\s*false\s*:\s*true/.test(s3Region)
  const driverFilter = /crmPeopleShowActive\s*\?\s*d\.is_active\s*!==\s*false\s*:\s*true/.test(s3Region)
  // Both patterns must appear; the manager pattern is used twice (managers + leasing_agents both).
  const managerAppearances = (s3Region.match(/crmPeopleShowActive\s*\?\s*u\.is_active\s*!==\s*false/g) || []).length
  const test2 = mgrFilter && driverFilter && managerAppearances >= 2
  console.log(`  managers/LAs filter present (${managerAppearances}× u): ${mgrFilter ? '🟢' : '🔴'}  drivers filter present: ${driverFilter ? '🟢' : '🔴'}`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Toggle affordance present in each CRM branch ─────────────
  console.log('─── [3] Toggle affordance in each CRM branch ────────────────')
  const propToggle = /setCrmPropertiesShowActive/.test(s2Region) && /Active only|Show all/.test(s2Region)
  const peopleToggle = /setCrmPeopleShowActive/.test(s3Region) && /Active only|Show all/.test(s3Region)
  const test3 = propToggle && peopleToggle
  console.log(`  Properties toggle: ${propToggle ? '🟢' : '🔴'}  People toggle: ${peopleToggle ? '🟢' : '🔴'}`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Per-section — two independent setters ────────────────────
  console.log('─── [4] Per-section state (NOT one shared flag) ─────────────')
  // The two setters must exist as distinct identifiers.
  const twoSetters = /setCrmPropertiesShowActive/.test(src) && /setCrmPeopleShowActive/.test(src)
  // Slice 2 must NOT reference the People setter; Slice 3 must NOT reference the Properties setter.
  const s2NoLeak = !/setCrmPeopleShowActive/.test(s2Region)
  const s3NoLeak = !/setCrmPropertiesShowActive/.test(s3Region)
  const test4 = twoSetters && s2NoLeak && s3NoLeak
  console.log(`  two setters present: ${twoSetters ? '🟢' : '🔴'}  Properties region no People-setter leak: ${s2NoLeak ? '🟢' : '🔴'}  People region no Properties-setter leak: ${s3NoLeak ? '🟢' : '🔴'}`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test0 && test1 && test2 && test3 && test4
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[0] scaffold: ${test0 ? '🟢' : '🔴'}  [1] properties filter: ${test1 ? '🟢' : '🔴'}  [2] people 3-group filter: ${test2 ? '🟢' : '🔴'}  [3] toggle affordances: ${test3 ? '🟢' : '🔴'}  [4] per-section state: ${test4 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

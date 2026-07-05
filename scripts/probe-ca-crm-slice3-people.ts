// CA CRM Slice 3 (Option A+) — People + name-edit static-source probe.
//
// Slice 3 groups Managers / Leasing Agents / Drivers, flips "No approve"
// copy to "Can't approve" in red, and adds one narrow capability: manager/
// leasing_agent NAME-ONLY edit (Option A+). Drivers get the existing
// updateDriver widget verbatim (no new driver mutation).
//
// Assertions:
//   [0] Scaffolding — editingUserEmail/editingUserName state; USER_NAME_EDIT_FIELDS
//       allowlist declared with name-only.
//   [1] People grouping — Managers / Leasing agents / Drivers labels present
//       in the CA_CRM_REDESIGN branch of manageSection === 'users'.
//   [2] "Can't approve" red copy — replaces "No approve" in the Slice 3 render.
//   [3] Driver Edit routes to existing setEditingDriver (no new driver mutation
//       in Slice 3 region).
//   [4] Manager/LA Edit routes to saveUserName with { name: ... } patch —
//       narrow allowlist enforced.
//   [5] saveUserName handler — allowlist scan: SELECT reads only
//       ('email', 'name') and UPDATE only takes allowlisted keys. No writes
//       to email/role/company/property/is_active/can_approve_vehicles.
//   [6] EDIT_USER audit action written (SCREAMING_SNAKE).
//   [7] No new supabase.from('user_roles').update in the Slice 3 region
//       OUTSIDE saveUserName (guards against a "quick-edit" bypassing the
//       allowlist).
//   [8] Legacy Users render preserved behind !CA_CRM_REDESIGN.
//   [9] No billing/$ phrasing in the People region.
//
// Run: npx tsx scripts/probe-ca-crm-slice3-people.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FILE = join(ROOT, 'app', 'company_admin', 'page.tsx')

function stripCodeComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function main() {
  console.log('══ CA CRM SLICE 3 PEOPLE PROBE ══════════════════════════════════')
  console.log('  Static source scan — no DB, no auth.\n')

  const src = readFileSync(FILE, 'utf-8')

  // ── Bound the Slice 3 render region ──────────────────────────────
  const regionStart = src.indexOf('SECTION 2 (CA CRM Slice 3)')
  const regionEnd = src.indexOf('SECTION 2 (LEGACY)', regionStart)
  if (regionStart < 0 || regionEnd < 0) {
    console.log('  🔴 could not locate Slice 3 region anchors')
    process.exit(2)
  }
  const region = src.slice(regionStart, regionEnd)
  const regionClean = stripCodeComments(region)

  // ── Bound the saveUserName handler region ────────────────────────
  const handlerStart = src.indexOf('async function saveUserName')
  const handlerEnd = src.indexOf('async function toggleUserActive', handlerStart)
  const handlerRegion = handlerStart >= 0 && handlerEnd >= 0 ? src.slice(handlerStart, handlerEnd) : ''
  const handlerClean = stripCodeComments(handlerRegion)

  // ── [0] Scaffolding ────────────────────────────────────────────────
  console.log('─── [0] SCAFFOLDING (state + allowlist) ─────────────────────')
  const stateOk = /editingUserEmail|editingUserName/.test(src)
  const allowlistDeclared = /const USER_NAME_EDIT_FIELDS\s*=\s*\['name'\]\s*as const/.test(src)
  const test0 = stateOk && allowlistDeclared
  console.log(`  state: ${stateOk ? '🟢' : '🔴'}  USER_NAME_EDIT_FIELDS = ['name'] as const: ${allowlistDeclared ? '🟢' : '🔴'}`)
  console.log(`  [0] ${test0 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [1] Grouping labels ────────────────────────────────────────────
  console.log('─── [1] Managers / Leasing agents / Drivers groups ──────────')
  const hasManagers = /Managers\s*<span/.test(region)
  const hasLA = /Leasing agents\s*<span/.test(region)
  const hasDrivers = /Drivers\s*<span/.test(region)
  const test1 = hasManagers && hasLA && hasDrivers
  console.log(`  Managers: ${hasManagers ? '🟢' : '🔴'}  Leasing agents: ${hasLA ? '🟢' : '🔴'}  Drivers: ${hasDrivers ? '🟢' : '🔴'}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] "Can't approve" red ────────────────────────────────────────
  console.log('─── [2] "Can\'t approve" copy (red) in Slice 3 region ────────')
  const cantApproveCopy = /Can\\?'t approve/.test(region)
  const noApproveGone = !/No Approve/.test(region)  // old copy must not appear in the CRM branch
  const test2 = cantApproveCopy && noApproveGone
  console.log(`  "Can't approve" copy present: ${cantApproveCopy ? '🟢' : '🔴'}  "No Approve" (old copy) absent from region: ${noApproveGone ? '🟢' : '🔴'}`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Driver Edit → existing setEditingDriver ──────────────────
  console.log('─── [3] Driver Edit routes to existing setEditingDriver ─────')
  const driverEditWired = /isDriver \?[\s\S]{0,200}setEditingDriver\(\{ \.\.\.u \}\)/.test(region)
  const test3 = driverEditWired
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL — driver Edit not routed to setEditingDriver'}\n`)

  // ── [4] Manager/LA Edit → saveUserName with name-only patch ──────
  console.log('─── [4] Manager Edit → saveUserName({name: ...}) narrow ─────')
  const managerEditWired = /saveUserName\(u\.email,\s*\{\s*name:/.test(region)
  const test4 = managerEditWired
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL — manager Edit not routed via saveUserName'}\n`)

  // ── [5] saveUserName handler enforces allowlist ──────────────────
  console.log('─── [5] saveUserName SELECT + UPDATE reads only allowlist ───')
  // SELECT must include email + name only (email needed for identity filter).
  const selectOnlyAllowlist = /\.select\('email, name'\)/.test(handlerRegion)
  // Filter loop reads USER_NAME_EDIT_FIELDS.includes(k).
  const filterLoop = /USER_NAME_EDIT_FIELDS as readonly string\[\]\)\.includes\(k\)/.test(handlerRegion)
  // Update takes `clean` (filtered object), not the raw patch.
  const updateTakesClean = /\.update\(clean\)/.test(handlerRegion)
  // Negative — no direct writes to forbidden fields anywhere in handler.
  const forbiddenWrites = /\.update\(\{[^}]*(email|role|company|property|is_active|can_approve_vehicles):/.test(handlerRegion)
  const test5 = selectOnlyAllowlist && filterLoop && updateTakesClean && !forbiddenWrites
  console.log(`  SELECT 'email, name' only: ${selectOnlyAllowlist ? '🟢' : '🔴'}  filter loop: ${filterLoop ? '🟢' : '🔴'}  UPDATE takes clean: ${updateTakesClean ? '🟢' : '🔴'}  no forbidden-field writes: ${!forbiddenWrites ? '🟢' : '🔴'}`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [6] EDIT_USER audit ────────────────────────────────────────────
  console.log('─── [6] EDIT_USER audit action written (SCREAMING_SNAKE) ────')
  const editUserAudit = /auditLog\('EDIT_USER',\s*'user_roles'/.test(handlerRegion)
  const test6 = editUserAudit
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [7] No user_roles UPDATE in region outside saveUserName ──────
  console.log('─── [7] No user_roles UPDATE inside Slice 3 render region ───')
  // The render region should never contain a supabase.from('user_roles').update
  // directly — those should route through saveUserName (which lives outside
  // the render region).
  const bypassUpdate = /supabase\.from\(['"]user_roles['"]\)[\s\S]{0,80}\.update/.test(region)
  const test7 = !bypassUpdate
  console.log(`  [7] ${test7 ? '🟢 PASS — no bypass writes' : '🔴 FAIL — direct user_roles UPDATE found in render region'}\n`)

  // ── [8] Legacy Users render preserved ────────────────────────────
  console.log('─── [8] Legacy Users render preserved behind !CA_CRM_REDESIGN ─')
  const legacyKept = /SECTION 2 \(LEGACY\)/.test(src) && /!CA_CRM_REDESIGN/.test(src)
  const test8 = legacyKept
  console.log(`  [8] ${test8 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [9] No billing/$ phrasing in People region ───────────────────
  console.log('─── [9] No metered/billed/invoice/$ in People region ────────')
  const banned = ['metered', 'billed', 'invoice']
  const cleanLower = regionClean.toLowerCase()
  const wordHits = banned.filter(w => cleanLower.includes(w))
  let dollarHit = false
  for (let i = 0; i < regionClean.length; i++) {
    if (regionClean[i] === '$' && regionClean[i+1] !== '{') { dollarHit = true; break }
  }
  const test9 = wordHits.length === 0 && !dollarHit
  if (wordHits.length) console.log(`  🔴 banned words: ${wordHits.join(', ')}`)
  if (dollarHit) console.log(`  🔴 literal $ found (not \${...} template)`)
  console.log(`  [9] ${test9 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test0 && test1 && test2 && test3 && test4 && test5 && test6 && test7 && test8 && test9
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[0] scaffold: ${test0 ? '🟢' : '🔴'}  [1] groups: ${test1 ? '🟢' : '🔴'}  [2] can't-approve red: ${test2 ? '🟢' : '🔴'}  [3] driver→setEditingDriver: ${test3 ? '🟢' : '🔴'}  [4] mgr→saveUserName: ${test4 ? '🟢' : '🔴'}  [5] allowlist enforced: ${test5 ? '🟢' : '🔴'}  [6] EDIT_USER audit: ${test6 ? '🟢' : '🔴'}  [7] no bypass write: ${test7 ? '🟢' : '🔴'}  [8] legacy preserved: ${test8 ? '🟢' : '🔴'}  [9] no billing/$: ${test9 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

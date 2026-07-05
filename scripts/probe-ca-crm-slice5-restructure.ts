// CA CRM Slice 5 — Tab restructure + change-logo + Partners CRM.
// Static-source-region probe.
//
// Slice 5 (final):
//   · New 6-section top nav behind CA_CRM_REDESIGN (Properties · People ·
//     Partners · Activity · Insights · Billing) — routes to existing
//     internal state (activeTab + manageSection).
//   · Track-gated sections: Activity → VIOLATION_DOCUMENTATION,
//     Partners → STORAGE_FACILITY_MANAGEMENT, Drivers group (People) →
//     DRIVER_PORTAL. Post-ENF_LEGACY-all-on, Legacy shows all; enf_only
//     shows enforcement-track only; pm_only shows PM-track only.
//   · QR Codes / Plan / Bulk Upload / Plate Lookup omitted from new nav
//     (functions re-homed). Legacy render preserved behind !CA_CRM_REDESIGN.
//   · Change-logo affordance in the account header (behind flag). Reuses
//     existing logoField + uploadLogo primitives. Narrow allowlist
//     (COMPANY_LOGO_EDITABLE_FIELDS = ['logo_url']) + EDIT_COMPANY_LOGO
//     audit.
//   · Partners active-only toggle (crmPartnersShowActive) matches
//     Slice-2/3 carry-over pattern.
//   · Stale-tab reset useEffect: if activeTab is a removed tab and flag is
//     on, reset to overview.
//
// The flip itself (CA_CRM_REDESIGN = true) is NOT in this commit — Jose
// walks the preview branch, then a separate one-line flip commit lands
// on main.
//
// Assertions:
//   [0] Scaffolding — companyLogoUrl + crmPartnersShowActive state
//       declared. COMPANY_LOGO_EDITABLE_FIELDS allowlist declared.
//   [1] New 6-section nav behind CA_CRM_REDESIGN with the section labels.
//   [2] Legacy nav preserved behind !CA_CRM_REDESIGN.
//   [3] Track gates on Partners + Activity + Drivers use hasFeature(...).
//   [4] QR Codes / Plan / Bulk Upload / Plate Lookup absent from new nav.
//   [5] saveCompanyLogo handler enforces allowlist + EDIT_COMPANY_LOGO
//       audit + writes only to companies.logo_url.
//   [6] change-logo affordance rendered in the account header behind
//       CA_CRM_REDESIGN via logoField.
//   [7] Partners active-only filter applied.
//   [8] Stale-tab reset useEffect gated on CA_CRM_REDESIGN.
//   [9] No new supabase mutation OUTSIDE saveCompanyLogo in the new-nav
//       or account-header regions.
//
// Run: npx tsx scripts/probe-ca-crm-slice5-restructure.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FILE = join(ROOT, 'app', 'company_admin', 'page.tsx')

function stripCodeComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function main() {
  console.log('══ CA CRM SLICE 5 RESTRUCTURE PROBE ═════════════════════════════')
  console.log('  Static source scan — no DB, no auth.\n')

  const src = readFileSync(FILE, 'utf-8')

  // ── Bound the new-nav region ─────────────────────────────────────
  const navStart = src.indexOf('CA CRM Slice 5 — 6-section top nav')
  const navEnd = src.indexOf('Legacy nav — preserved', navStart)
  if (navStart < 0 || navEnd < 0) { console.log('  🔴 could not locate new-nav region'); process.exit(2) }
  const navRegion = src.slice(navStart, navEnd)

  // Bound the saveCompanyLogo handler.
  const handlerStart = src.indexOf('async function saveCompanyLogo')
  const handlerEnd = src.indexOf('async function saveFacility', handlerStart)
  const handlerRegion = handlerStart >= 0 && handlerEnd >= 0 ? src.slice(handlerStart, handlerEnd) : ''

  // Bound the account header region.
  const hdrStart = src.indexOf('Company Admin Portal')
  const hdrEnd = src.indexOf('Tabs + tab content', hdrStart)
  const hdrRegion = hdrStart >= 0 && hdrEnd >= 0 ? src.slice(hdrStart, hdrEnd) : ''

  // ── [0] Scaffolding ────────────────────────────────────────────────
  console.log('─── [0] SCAFFOLDING (state + allowlist) ─────────────────────')
  const logoState = /const\s+\[companyLogoUrl,\s*setCompanyLogoUrl\]\s*=\s*useState<string>\(''\)/.test(src)
  const partnersState = /const\s+\[crmPartnersShowActive,\s*setCrmPartnersShowActive\]\s*=\s*useState<boolean>\(true\)/.test(src)
  const allowlist = /const COMPANY_LOGO_EDITABLE_FIELDS\s*=\s*\['logo_url'\]\s*as const/.test(src)
  const test0 = logoState && partnersState && allowlist
  console.log(`  logo state: ${logoState ? '🟢' : '🔴'}  partners state: ${partnersState ? '🟢' : '🔴'}  allowlist: ${allowlist ? '🟢' : '🔴'}`)
  console.log(`  [0] ${test0 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [1] New 6-section nav ───────────────────────────────────────
  console.log('─── [1] New 6-section nav labels present in nav region ──────')
  const labels = ['Overview', 'Properties', 'People', 'Partners', 'Activity', 'Insights', 'Billing']
  const missing = labels.filter(l => !new RegExp(`>${l}<`).test(navRegion))
  const test1 = missing.length === 0
  if (missing.length) console.log(`  🔴 missing: ${missing.join(', ')}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] Legacy nav preserved ────────────────────────────────────
  console.log('─── [2] Legacy nav preserved behind !CA_CRM_REDESIGN ────────')
  const legacyKept = /Legacy nav — preserved behind !CA_CRM_REDESIGN/.test(src) && /!CA_CRM_REDESIGN/.test(src)
  const test2 = legacyKept
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Track gates via hasFeature ──────────────────────────────
  console.log('─── [3] Track gates — hasFeature() on Activity / Partners / Drivers ─')
  const activityGate = /const showActivity\s*=\s*hasFeature\(FEATURE_FLAGS\.VIOLATION_DOCUMENTATION,\s*ctx\)\s*===\s*true/.test(navRegion)
  const partnersGate = /const showPartners\s*=\s*hasFeature\(FEATURE_FLAGS\.STORAGE_FACILITY_MANAGEMENT,\s*ctx\)\s*===\s*true/.test(navRegion)
  const driversGateInSrc = /hasFeature\(FEATURE_FLAGS\.DRIVER_PORTAL,\s*getCompanyContext\(\)\)\s*===\s*true/.test(src)
  const test3 = activityGate && partnersGate && driversGateInSrc
  console.log(`  Activity gate: ${activityGate ? '🟢' : '🔴'}  Partners gate: ${partnersGate ? '🟢' : '🔴'}  Drivers gate: ${driversGateInSrc ? '🟢' : '🔴'}`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Omitted tabs absent from new nav ────────────────────────
  console.log('─── [4] QR/Plan/BulkUpload/PlateLookup absent from new nav ──')
  const omitted = ['QR Codes', 'Plan', 'Bulk Upload', 'Plate Lookup']
  const leaks = omitted.filter(o => new RegExp(`>${o}<`).test(navRegion))
  const test4 = leaks.length === 0
  if (leaks.length) console.log(`  🔴 leaked into new nav: ${leaks.join(', ')}`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] saveCompanyLogo handler enforces allowlist ──────────────
  console.log('─── [5] saveCompanyLogo allowlist + audit + narrow write ────')
  const allowlistLoop = /COMPANY_LOGO_EDITABLE_FIELDS as readonly string\[\]\)\.includes\(k\)/.test(handlerRegion)
  const editUserAudit = /auditLog\('EDIT_COMPANY_LOGO',\s*'companies'/.test(handlerRegion)
  const narrowWrite = /\.update\(patch\)/.test(handlerRegion) && /supabase\.from\('companies'\)/.test(handlerRegion)
  const forbiddenFieldWrite = /\.update\(\{[^}]*(tier|stripe|subscription|role):/.test(handlerRegion)
  const test5 = allowlistLoop && editUserAudit && narrowWrite && !forbiddenFieldWrite
  console.log(`  allowlist loop: ${allowlistLoop ? '🟢' : '🔴'}  EDIT_COMPANY_LOGO audit: ${editUserAudit ? '🟢' : '🔴'}  narrow UPDATE(patch): ${narrowWrite ? '🟢' : '🔴'}  no forbidden-field writes: ${!forbiddenFieldWrite ? '🟢' : '🔴'}`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [6] Account-header change-logo affordance ───────────────────
  console.log('─── [6] Account-header change-logo affordance (behind flag) ─')
  const hdrFlagGate = /\{CA_CRM_REDESIGN && role\?\.company &&/.test(hdrRegion)
  const hdrLogoField = /logoField\(\s*companyLogoUrl/.test(hdrRegion)
  const hdrCallsSave = /url\s*=>\s*saveCompanyLogo\(url\)/.test(hdrRegion)
  const test6 = hdrFlagGate && hdrLogoField && hdrCallsSave
  console.log(`  flag-gated: ${hdrFlagGate ? '🟢' : '🔴'}  logoField(companyLogoUrl): ${hdrLogoField ? '🟢' : '🔴'}  onChange → saveCompanyLogo: ${hdrCallsSave ? '🟢' : '🔴'}`)
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [7] Partners active-only filter applied ─────────────────────
  console.log('─── [7] Partners (Storage) active-only filter applied ───────')
  const partnersFilter = /\.filter\(\(f:\s*any\)\s*=>\s*\(CA_CRM_REDESIGN\s*&&\s*crmPartnersShowActive\)\s*\?\s*f\.is_active\s*:\s*true\)/.test(src)
  const partnersToggle = /setCrmPartnersShowActive\(s\s*=>\s*!s\)/.test(src)
  const test7 = partnersFilter && partnersToggle
  console.log(`  filter applied: ${partnersFilter ? '🟢' : '🔴'}  toggle affordance: ${partnersToggle ? '🟢' : '🔴'}`)
  console.log(`  [7] ${test7 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [8] Stale-tab reset useEffect ───────────────────────────────
  console.log('─── [8] Stale-tab reset useEffect gated on flag ─────────────')
  const staleReset = /useEffect\([\s\S]{0,200}CA_CRM_REDESIGN[\s\S]{0,300}REMOVED_TABS[\s\S]{0,120}setActiveTab\('overview'\)/.test(src)
  const test8 = staleReset
  console.log(`  [8] ${test8 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [9] No new mutation outside saveCompanyLogo ─────────────────
  console.log('─── [9] No new mutation in new-nav or account-header regions ─')
  const navMutation = /supabase\.from\([^)]+\)[\s\S]{0,80}\.(insert|update|delete)\(/.test(navRegion)
  const hdrMutation = /supabase\.from\([^)]+\)[\s\S]{0,80}\.(insert|update|delete)\(/.test(hdrRegion)
  const test9 = !navMutation && !hdrMutation
  console.log(`  no mutation in nav region: ${!navMutation ? '🟢' : '🔴'}  no mutation in header region: ${!hdrMutation ? '🟢' : '🔴'}`)
  console.log(`  [9] ${test9 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test0 && test1 && test2 && test3 && test4 && test5 && test6 && test7 && test8 && test9
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[0]:${test0 ? '🟢' : '🔴'} [1]:${test1 ? '🟢' : '🔴'} [2]:${test2 ? '🟢' : '🔴'} [3]:${test3 ? '🟢' : '🔴'} [4]:${test4 ? '🟢' : '🔴'} [5]:${test5 ? '🟢' : '🔴'} [6]:${test6 ? '🟢' : '🔴'} [7]:${test7 ? '🟢' : '🔴'} [8]:${test8 ? '🟢' : '🔴'} [9]:${test9 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

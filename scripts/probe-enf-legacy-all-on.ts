// ENF_LEGACY = all-on flip — verification probe.
//
// Verifies the 2026-07-05 flip that makes Legacy (both tracks) genuinely
// all-on / max capabilities so A1 (Enforcement-track Legacy) launches
// with the resident portal + PM CRM it needs.
//
// Load-bearing safety assertion is [3]: ENF_ENFORCEMENT_ONLY deep-equals
// a captured snapshot of the pre-flip enf_only shape — proves the clone
// break did not regress the barebones tier. If point [5] comes back
// TRUE (barebones getting a resident portal), the flip regressed
// and must be reverted before push.
//
// Assertions:
//   [1] TIER_CONFIG.enforcement.legacy — every flag at all-on target.
//   [2] TIER_CONFIG.property_management.legacy — every flag at all-on
//       target. Post-flip should DEEP-EQUAL enforcement.legacy.
//   [3] TIER_CONFIG.enforcement.enforcement_only — DEEP-EQUALS the
//       captured pre-flip snapshot (32 flags + 6 caps). Proves the
//       clone break preserved byte-identical behavior.
//   [4] hasFeature(RESIDENT_PORTAL, {tier:'legacy', tier_type:'enforcement'})
//       === true (A1 gets resident portal).
//   [5] hasFeature(RESIDENT_PORTAL, {tier:'enforcement_only',
//       tier_type:'enforcement'}) === FALSE (barebones unchanged).
//       ⚠ Load-bearing regression check.
//
// Run: npx tsx scripts/probe-enf-legacy-all-on.ts

import { TIER_CONFIG } from '../app/lib/tier-config'
import { hasFeature } from '../app/lib/tier'
import { FEATURE_FLAGS } from '../app/lib/feature-flags'

const F = FEATURE_FLAGS

// Pre-flip snapshot of ENF_ENFORCEMENT_ONLY — captured from the shape
// ENF_LEGACY resolved to BEFORE the all-on flip. This is what enf_only
// MUST equal after the flip. Any drift = regression.
const ENF_ENFORCEMENT_ONLY_PRE_FLIP_SNAPSHOT: Record<string, boolean | number> = {
  [F.MAX_PROPERTIES]: -1,
  [F.MAX_DRIVERS]: -1,
  [F.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH]: 0,
  [F.MAX_VISITOR_PASS_DURATION_HOURS]: 0,
  [F.VIDEO_MAX_DURATION_SECONDS]: 120,
  [F.MAX_PHOTOS_PER_VIOLATION]: -1,
  [F.AI_PLATE_SCANNING]: true,
  [F.VIOLATION_DOCUMENTATION]: true,
  [F.TOW_TICKET_GENERATION]: true,
  [F.TOWING_AUTHORIZATION_UI]: true,
  [F.DRIVER_PORTAL]: true,
  [F.STORAGE_FACILITY_MANAGEMENT]: true,
  [F.PHOTO_UPLOADS]: true,
  [F.FINDMYTOWEDCAR_LINKS]: true,
  [F.CSV_EXPORT_BASIC]: true,
  [F.RESIDENT_MANAGEMENT]: true,
  [F.VISITOR_PASS_MANAGEMENT]: true,
  [F.MANAGER_PORTAL]: true,
  [F.AUDIT_LOGS]: true,
  [F.CUSTOM_LOGO_BRANDING]: true,
  [F.MOBILE_FRIENDLY_PORTALS]: true,
  [F.BASIC_DASHBOARDS]: true,
  [F.EMAIL_SUPPORT]: true,
  [F.PROPERTY_MANAGEMENT]: false,
  [F.RESIDENT_SELF_REGISTRATION]: false,
  [F.VISITOR_PASS_SELF_SERVICE]: false,
  [F.RESIDENT_PORTAL]: false,
  [F.VEHICLE_REGISTRY]: false,
  [F.MULTIPLE_MANAGERS_PER_PROPERTY]: false,
  [F.MANAGER_PLATE_LOOKUP]: true,
  [F.LEASING_AGENT_ROLE]: true,
  [F.ADVANCED_ANALYTICS]: true,
  [F.CUSTOM_DATE_RANGE_EXPORTS]: true,
  [F.ADVANCED_PDF_REPORTS]: true,
  [F.PRIORITY_SUPPORT]: true,
  [F.DEDICATED_ACCOUNT_MANAGER]: true,
  [F.BULK_UPLOAD]: true,
  [F.TOWBOOK_CSV_EXPORT]: true,
  [F.API_ACCESS_READ_ONLY]: true,
  [F.VIDEO_UPLOADS_LIMITED]: false,
  [F.VIDEO_UPLOADS_FULL]: true,
}

// Legacy all-on target — booleans all true, numerics at max/unlimited.
const LEGACY_ALL_ON_TARGET: Record<string, boolean | number> = {
  // Numeric caps at max
  [F.MAX_PROPERTIES]: -1,
  [F.MAX_DRIVERS]: -1,
  [F.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH]: -1,
  [F.MAX_VISITOR_PASS_DURATION_HOURS]: 48,
  [F.VIDEO_MAX_DURATION_SECONDS]: 120,
  [F.MAX_PHOTOS_PER_VIOLATION]: -1,
  // Enforcement-track core
  [F.AI_PLATE_SCANNING]: true,
  [F.VIOLATION_DOCUMENTATION]: true,
  [F.TOW_TICKET_GENERATION]: true,
  [F.TOWING_AUTHORIZATION_UI]: true,
  [F.DRIVER_PORTAL]: true,
  [F.STORAGE_FACILITY_MANAGEMENT]: true,
  [F.PHOTO_UPLOADS]: true,
  [F.FINDMYTOWEDCAR_LINKS]: true,
  [F.CSV_EXPORT_BASIC]: true,
  // Cross-track core
  [F.RESIDENT_MANAGEMENT]: true,
  [F.VISITOR_PASS_MANAGEMENT]: true,
  [F.MANAGER_PORTAL]: true,
  [F.AUDIT_LOGS]: true,
  [F.CUSTOM_LOGO_BRANDING]: true,
  [F.MOBILE_FRIENDLY_PORTALS]: true,
  [F.BASIC_DASHBOARDS]: true,
  [F.EMAIL_SUPPORT]: true,
  // PM-track core — ALL TRUE on Legacy (this is the A1 fix)
  [F.PROPERTY_MANAGEMENT]: true,
  [F.RESIDENT_SELF_REGISTRATION]: true,
  [F.VISITOR_PASS_SELF_SERVICE]: true,
  [F.RESIDENT_PORTAL]: true,
  [F.VEHICLE_REGISTRY]: true,
  [F.MULTIPLE_MANAGERS_PER_PROPERTY]: true,
  [F.MANAGER_PLATE_LOOKUP]: true,
  // Tiered cross-track
  [F.LEASING_AGENT_ROLE]: true,
  [F.ADVANCED_ANALYTICS]: true,
  [F.CUSTOM_DATE_RANGE_EXPORTS]: true,
  [F.ADVANCED_PDF_REPORTS]: true,
  [F.PRIORITY_SUPPORT]: true,
  [F.DEDICATED_ACCOUNT_MANAGER]: true,
  [F.BULK_UPLOAD]: true,
  // Tiered enforcement-only — TRUE on Legacy (Legacy = all-on)
  [F.TOWBOOK_CSV_EXPORT]: true,
  [F.API_ACCESS_READ_ONLY]: true,
  [F.VIDEO_UPLOADS_LIMITED]: false,   // matrix design: Legacy = full only, limited off
  [F.VIDEO_UPLOADS_FULL]: true,
}

function deepEqualEntries(actual: any, expected: Record<string, boolean | number>): { ok: boolean; diffs: string[] } {
  const diffs: string[] = []
  for (const [k, v] of Object.entries(expected)) {
    if (actual?.[k] !== v) {
      diffs.push(`${k}: expected=${JSON.stringify(v)} actual=${JSON.stringify(actual?.[k])}`)
    }
  }
  return { ok: diffs.length === 0, diffs }
}

async function main() {
  console.log('══ ENF_LEGACY = all-on FLIP PROBE ═══════════════════════════════')
  console.log('  Pure-function scan of TIER_CONFIG + hasFeature.\n')

  // ── [1] enforcement.legacy at all-on target ──────────────────────
  console.log('─── [1] TIER_CONFIG.enforcement.legacy = all-on target ──────')
  const enfLegacy = (TIER_CONFIG as any).enforcement.legacy
  const chk1 = deepEqualEntries(enfLegacy, LEGACY_ALL_ON_TARGET)
  const test1 = chk1.ok
  if (!test1) chk1.diffs.forEach(d => console.log(`  🔴 ${d}`))
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] property_management.legacy at all-on target ──────────────
  console.log('─── [2] TIER_CONFIG.property_management.legacy = all-on target ─')
  const pmLegacy = (TIER_CONFIG as any).property_management.legacy
  const chk2 = deepEqualEntries(pmLegacy, LEGACY_ALL_ON_TARGET)
  const test2 = chk2.ok
  if (!test2) chk2.diffs.forEach(d => console.log(`  🔴 ${d}`))
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] enforcement.enforcement_only == pre-flip snapshot ────────
  console.log('─── [3] enforcement.enforcement_only DEEP-EQUALS pre-flip snapshot ─')
  const enfOnly = (TIER_CONFIG as any).enforcement.enforcement_only
  const chk3 = deepEqualEntries(enfOnly, ENF_ENFORCEMENT_ONLY_PRE_FLIP_SNAPSHOT)
  const test3 = chk3.ok
  if (!test3) chk3.diffs.forEach(d => console.log(`  🔴 REGRESSION ${d}`))
  console.log(`  [3] ${test3 ? '🟢 PASS — barebones frozen' : '🔴 FAIL — CLONE BREAK REGRESSED'}\n`)

  // ── [4] Legacy Enforcement has RESIDENT_PORTAL ═══════════════════
  console.log('─── [4] hasFeature(RESIDENT_PORTAL, Legacy Enforcement) = true ─')
  const legacyEnfCtx = { tier: 'legacy', tier_type: 'enforcement', proposal_code: null }
  const legacyEnfPortal = hasFeature(F.RESIDENT_PORTAL, legacyEnfCtx as any)
  const test4 = legacyEnfPortal === true
  console.log(`  result: ${legacyEnfPortal} (expect true)`)
  console.log(`  [4] ${test4 ? '🟢 PASS — A1 gets resident portal' : '🔴 FAIL — A1 blocker'}\n`)

  // ── [5] enforcement_only does NOT have RESIDENT_PORTAL ───────────
  console.log('─── [5] hasFeature(RESIDENT_PORTAL, enforcement_only) = FALSE ⚠ load-bearing ─')
  const enfOnlyCtx = { tier: 'enforcement_only', tier_type: 'enforcement', proposal_code: null }
  const enfOnlyPortal = hasFeature(F.RESIDENT_PORTAL, enfOnlyCtx as any)
  const test5 = enfOnlyPortal === false
  console.log(`  result: ${enfOnlyPortal} (expect false)`)
  console.log(`  [5] ${test5 ? '🟢 PASS — barebones unchanged' : '🔴 FAIL — REGRESSION, barebones gained portal — STOP'}\n`)

  const allPass = test1 && test2 && test3 && test4 && test5
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] enf.legacy all-on: ${test1 ? '🟢' : '🔴'}  [2] pm.legacy all-on: ${test2 ? '🟢' : '🔴'}  [3] enf_only snapshot: ${test3 ? '🟢' : '🔴'}  [4] Legacy Enf portal: ${test4 ? '🟢' : '🔴'}  [5] enf_only NO portal: ${test5 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

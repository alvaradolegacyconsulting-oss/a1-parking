// CA CRM Slice 1 — Plan strip static-source-region probe.
//
// Slice 1 rearranges data the portal already fetches into a single Plan
// strip: plan label, base+per-property (or "Tailored rate" for Legacy),
// permit tile (PM-only), property count, Manage-Billing (Stripe portal
// reuse), All-property QR bulk-print, expandable "What's included".
//
// This probe scans the source region of the Plan strip and enforces the
// subscriber-only + Slice-scoping constraints:
//   [0] SCAFFOLDING — CA_CRM_REDESIGN const declared; TIER_PRICING +
//       TIER_CONFIG imports present.
//   [1] NO $/PERMIT MATH — the strip carries no per-permit dollar
//       calculation (Slice 7 Part B owns the full graduated $ breakdown;
//       Slice 1 shows count + light tag only).
//   [2] NO "billed" PHRASING in strip region (subscriber-only rule
//       forbids the "billed"/"invoice" framing even on the CA surface
//       — that lives on the Stripe portal + Slice 7 Part B's tile).
//   [3] TIER LABEL BRANCHES — the strip contains the branching for
//       "Property Management" / "Enforcement" / "· Legacy" suffix.
//   [4] PERMIT TILE GATED ON PM — the tile renders {isPM ?
//       approvedPermitCount : '—'} conditionally.
//   [5] LEGACY BRANCHES — "Tailored rate" branch present; catalog
//       branch renders $baseMonthly/mo base + $perPropertyRate/property.
//   [6] MANAGE-BILLING BUTTON — reuses openBillingPortal handler.
//   [7] ALL-PROPERTY QR BUTTON — printAllPropertyQRSigns handler
//       wired; button disabled when propertyCount === 0.
//   [8] "* plus applicable taxes" note present (only on catalog branch).
//   [9] "What's included" expandable — reads TIER_CONFIG for the
//       resolved (tier_type, tier).
//
// Static source scan — no DB, no auth. If the SCAFFOLDING assertions
// pass and the region-scoped strings match, the strip is composed
// correctly. Real render behavior verified separately by Jose eyeball
// after the CA_CRM_REDESIGN flip.
//
// Run: npx tsx scripts/probe-ca-crm-slice1-plan-strip.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FILE = join(ROOT, 'app', 'company_admin', 'page.tsx')

function stripCodeComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function main() {
  console.log('══ CA CRM SLICE 1 PLAN STRIP PROBE ══════════════════════════════')
  console.log('  Static source scan — no DB, no auth.\n')

  const src = readFileSync(FILE, 'utf-8')

  // ── [0] SCAFFOLDING ────────────────────────────────────────────────
  console.log('─── [0] SCAFFOLDING (flag + imports) ────────────────────────')
  const flagOk = /const CA_CRM_REDESIGN = false/.test(src)
  const tierPricingImport = /TIER_PRICING/.test(src)
  const tierConfigImport = /TIER_CONFIG/.test(src)
  const test0 = flagOk && tierPricingImport && tierConfigImport
  console.log(`  CA_CRM_REDESIGN const: ${flagOk ? '🟢' : '🔴'}  TIER_PRICING import: ${tierPricingImport ? '🟢' : '🔴'}  TIER_CONFIG import: ${tierConfigImport ? '🟢' : '🔴'}`)
  console.log(`  [0] ${test0 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── Bound the Plan strip region ───────────────────────────────────
  const stripStart = src.indexOf('PLAN STRIP (CA CRM Slice 1')
  const stripEnd = src.indexOf('PLAN (Phase 2a) — LEGACY TAB', stripStart)
  if (stripStart < 0 || stripEnd < 0) {
    console.log('  🔴 could not locate strip region anchors')
    process.exit(2)
  }
  const stripRegion = src.slice(stripStart, stripEnd)
  const stripClean = stripCodeComments(stripRegion)

  // ── [1] NO $/PERMIT MATH ───────────────────────────────────────────
  console.log('─── [1] No $/permit math (Slice 7 Part B owns that) ─────────')
  // Watch for '/permit' or '$/permit' or per-permit $ multiplication
  const hasPerPermitDollars = /\/permit|per_?permit\s*[×*]\s*\$/i.test(stripClean)
  const test1 = !hasPerPermitDollars
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL — found /permit or per_permit×$ math'}\n`)

  // ── [2] NO "billed" phrasing ───────────────────────────────────────
  console.log('─── [2] No "billed" / "invoice" phrasing in strip region ────')
  const hasBilled = /\bbilled\b/i.test(stripClean)
  const hasInvoice = /\binvoice\b/i.test(stripClean)
  const test2 = !hasBilled && !hasInvoice
  if (!test2) {
    if (hasBilled) console.log(`  🔴 strip contains 'billed'`)
    if (hasInvoice) console.log(`  🔴 strip contains 'invoice'`)
  }
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Tier label branches present ────────────────────────────────
  console.log('─── [3] Tier label branches (PM / Enforcement / Legacy) ─────')
  const hasPmLabel = /Property Management/.test(stripRegion)
  const hasEnfLabel = /Enforcement/.test(stripRegion)
  const hasLegacyLabel = /Legacy/.test(stripRegion) || /isLegacy/.test(stripRegion)
  const test3 = hasPmLabel && hasEnfLabel && hasLegacyLabel
  console.log(`  PM: ${hasPmLabel ? '🟢' : '🔴'}  Enforcement: ${hasEnfLabel ? '🟢' : '🔴'}  Legacy: ${hasLegacyLabel ? '🟢' : '🔴'}`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Permit tile PM-only gate ──────────────────────────────────
  console.log('─── [4] Permit tile gated on isPM (dash for Enforcement) ────')
  const permitTileGated = /\{isPM\s*\?\s*approvedPermitCount\s*:\s*'—'\}/.test(stripRegion)
  const test4 = permitTileGated
  console.log(`  [4] ${test4 ? '🟢 PASS — {isPM ? approvedPermitCount : "—"}' : '🔴 FAIL — permit tile not conditionally rendered'}\n`)

  // ── [5] Legacy "Tailored rate" branch + catalog branch ─────────────
  console.log('─── [5] Legacy "Tailored rate" branch + catalog computation ─')
  const hasTailoredRate = /Tailored rate/.test(stripRegion)
  const hasCatalogFormula = /baseMonthly.*mo base.*perPropertyRate.*property/s.test(stripRegion)
  const test5 = hasTailoredRate && hasCatalogFormula
  console.log(`  Tailored rate: ${hasTailoredRate ? '🟢' : '🔴'}  catalog $base+$perProp: ${hasCatalogFormula ? '🟢' : '🔴'}`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [6] Manage-billing button reuses openBillingPortal ─────────────
  console.log('─── [6] Manage-billing button reuses openBillingPortal ──────')
  const manageBillingBtn = /onClick=\{openBillingPortal\}[\s\S]*Manage billing in Stripe/.test(stripRegion)
  const test6 = manageBillingBtn
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL — button not wired to openBillingPortal'}\n`)

  // ── [7] All-property QR button ────────────────────────────────────
  console.log('─── [7] All-property QR button wired to printAllPropertyQRSigns ─')
  const qrBtn = /onClick=\{printAllPropertyQRSigns\}[\s\S]*All-property QR/.test(stripRegion)
  const qrDisabledOnEmpty = /disabled=\{propertyCount === 0\}/.test(stripRegion)
  const test7 = qrBtn && qrDisabledOnEmpty
  console.log(`  wired: ${qrBtn ? '🟢' : '🔴'}  disabled-on-empty: ${qrDisabledOnEmpty ? '🟢' : '🔴'}`)
  console.log(`  [7] ${test7 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [8] Taxes note ─────────────────────────────────────────────────
  console.log('─── [8] "* plus applicable taxes" present on catalog branch ─')
  const taxNote = /plus applicable taxes/.test(stripRegion)
  const test8 = taxNote
  console.log(`  [8] ${test8 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [9] "What's included" reads TIER_CONFIG ────────────────────────
  console.log('─── [9] "What\'s included" reads TIER_CONFIG[tier_type][tier] ─')
  const whatsIncluded = /What&apos;s included|What's included/.test(stripRegion)
  const readsTierConfig = /TIER_CONFIG\[tierTypeKey\]\?\.\[tierKey\]/.test(stripRegion)
  const test9 = whatsIncluded && readsTierConfig
  console.log(`  panel present: ${whatsIncluded ? '🟢' : '🔴'}  reads TIER_CONFIG: ${readsTierConfig ? '🟢' : '🔴'}`)
  console.log(`  [9] ${test9 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test0 && test1 && test2 && test3 && test4 && test5 && test6 && test7 && test8 && test9
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[0] scaffold: ${test0 ? '🟢' : '🔴'}  [1] no $/permit: ${test1 ? '🟢' : '🔴'}  [2] no billed/invoice: ${test2 ? '🟢' : '🔴'}  [3] tier labels: ${test3 ? '🟢' : '🔴'}  [4] permit PM-gated: ${test4 ? '🟢' : '🔴'}  [5] Legacy branch: ${test5 ? '🟢' : '🔴'}  [6] manage-billing: ${test6 ? '🟢' : '🔴'}  [7] all-QR btn: ${test7 ? '🟢' : '🔴'}  [8] tax note: ${test8 ? '🟢' : '🔴'}  [9] What's included: ${test9 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

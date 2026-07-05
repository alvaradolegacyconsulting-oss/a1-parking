// CA CRM Slice 2 — Properties CRM static-source-region probe.
//
// Slice 2 lays out the existing property data as a two-panel CRM
// (list + detail) behind CA_CRM_REDESIGN. Reuses:
//   · properties state (already fetched)
//   · companyUsers state (assigned-managers derivable, zero new fetches)
//   · updateProperty / togglePropertyActive / printQRSign (existing)
//   · hasFeature(RESIDENT_PORTAL) to gate the resident-signup QR
//
// This probe scans the source region and enforces:
//   [0] Scaffolding — selectedPropertyId state; assigned-managers filter
//       reads companyUsers by role + property (no new fetch).
//   [1] Detail block presence — address, support email/phone, assigned
//       managers, auth-doc status.
//   [2] Edit + Deactivate wired to EXISTING handlers (setEditingProperty
//       + togglePropertyActive). No new mutation.
//   [3] QR block — visitor QR always present; resident-signup QR
//       conditionally rendered inside `showResidentQR &&` block that
//       resolves from hasFeature(FEATURE_FLAGS.RESIDENT_PORTAL, ctx).
//   [4] No billing/`$`/"metered"/"billed"/"invoice" phrasing in the
//       property detail region (operational surface).
//   [5] No new supabase.from(...) mutations — the slice adds NO new
//       write paths.
//
// Run: npx tsx scripts/probe-ca-crm-slice2-properties.ts

import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FILE = join(ROOT, 'app', 'company_admin', 'page.tsx')

function stripCodeComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function main() {
  console.log('══ CA CRM SLICE 2 PROPERTIES PROBE ══════════════════════════════')
  console.log('  Static source scan — no DB, no auth.\n')

  const src = readFileSync(FILE, 'utf-8')

  // ── Bound the Slice 2 region ─────────────────────────────────────
  const stripStart = src.indexOf('SECTION 1 — Properties (CA CRM Slice 2)')
  const stripEnd = src.indexOf('SECTION 1 (LEGACY) — Properties flat list', stripStart)
  if (stripStart < 0 || stripEnd < 0) {
    console.log('  🔴 could not locate Slice 2 region anchors')
    process.exit(2)
  }
  const region = src.slice(stripStart, stripEnd)
  const clean = stripCodeComments(region)

  // ── [0] Scaffolding ────────────────────────────────────────────────
  console.log('─── [0] SCAFFOLDING (state + managers-derivation) ───────────')
  const stateOk = /selectedPropertyId|crmPropertySearch/.test(src)
  const managersDerived = /companyUsers\.filter[\s\S]{0,200}u\.role[\s\S]{0,80}u\.property/m.test(region)
  const test0 = stateOk && managersDerived
  console.log(`  selectedPropertyId/crmPropertySearch state: ${stateOk ? '🟢' : '🔴'}  assigned-managers from companyUsers: ${managersDerived ? '🟢' : '🔴'}`)
  console.log(`  [0] ${test0 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [1] Detail block presence ────────────────────────────────────
  console.log('─── [1] Detail composes address + support + managers + auth ─')
  const hasAddress = /selected\.address/.test(region)
  const hasPmEmail = /selected\.pm_email/.test(region)
  const hasPmPhone = /selected\.pm_phone/.test(region)
  const hasAssignedManagersBlock = /Assigned managers/.test(region)
  const hasAuthDocBlock = /Authorization document/.test(region) && /authorization_pdf_path/.test(region)
  const test1 = hasAddress && hasPmEmail && hasPmPhone && hasAssignedManagersBlock && hasAuthDocBlock
  console.log(`  address: ${hasAddress ? '🟢' : '🔴'}  pm_email: ${hasPmEmail ? '🟢' : '🔴'}  pm_phone: ${hasPmPhone ? '🟢' : '🔴'}  managers block: ${hasAssignedManagersBlock ? '🟢' : '🔴'}  auth-doc block: ${hasAuthDocBlock ? '🟢' : '🔴'}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] Edit + Deactivate wired to existing handlers ─────────────
  console.log('─── [2] Edit + Deactivate reuse existing handlers ───────────')
  const editHandler = /setEditingProperty\(\{[\s\S]{0,40}\.\.\.selected/.test(region)
  const deactivateHandler = /togglePropertyActive\(selected\)/.test(region)
  const test2 = editHandler && deactivateHandler
  console.log(`  Edit → setEditingProperty: ${editHandler ? '🟢' : '🔴'}  Deactivate → togglePropertyActive: ${deactivateHandler ? '🟢' : '🔴'}`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] QR block — resident-signup gated on RESIDENT_PORTAL ──────
  console.log('─── [3] Visitor QR always; Resident-signup QR gated on RESIDENT_PORTAL ─')
  const showResidentDerivation = /const showResidentQR\s*=\s*hasFeature\(FEATURE_FLAGS\.RESIDENT_PORTAL,\s*ctx\)\s*===\s*true/.test(region)
  const visitorQrAlways = /Visitor Pass/.test(region) && /\/visitor\?property=/.test(region)
  const residentQrConditional = /\{showResidentQR\s*&&/.test(region) && /Resident Signup/.test(region) && /\/register\?property=/.test(region)
  const test3 = showResidentDerivation && visitorQrAlways && residentQrConditional
  console.log(`  showResidentQR derived from hasFeature(RESIDENT_PORTAL): ${showResidentDerivation ? '🟢' : '🔴'}`)
  console.log(`  Visitor QR unconditional: ${visitorQrAlways ? '🟢' : '🔴'}`)
  console.log(`  Resident QR inside \`{showResidentQR &&\`: ${residentQrConditional ? '🟢' : '🔴'}`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] No billing/$ phrasing in property detail region ──────────
  console.log('─── [4] No billing/metered/billed/invoice/$ in detail region ─')
  const banned = ['metered', 'billed', 'invoice']
  const cleanLower = clean.toLowerCase()
  const wordHits = banned.filter(w => cleanLower.includes(w))
  // Dollar figure — literal $ not preceded by ${...} template
  let dollarHit = false
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '$' && clean[i+1] !== '{') { dollarHit = true; break }
  }
  const test4 = wordHits.length === 0 && !dollarHit
  if (wordHits.length) console.log(`  🔴 banned words: ${wordHits.join(', ')}`)
  if (dollarHit) console.log(`  🔴 literal $ found (not \${...} template)`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] No new supabase mutation calls in the Slice 2 region ─────
  console.log('─── [5] Slice 2 adds NO new supabase mutations (read-only reorg) ─')
  // Slice 2 must reuse existing handlers only. Any `supabase.from(...)`
  // .insert/.update/.delete in the region is a red flag.
  const newMutation = /supabase\.from\([^)]+\)[\s\S]{0,80}\.(insert|update|delete)\(/.test(region)
  const test5 = !newMutation
  console.log(`  no new supabase.insert/update/delete: ${test5 ? '🟢' : '🔴'}`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  const allPass = test0 && test1 && test2 && test3 && test4 && test5
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[0] scaffold: ${test0 ? '🟢' : '🔴'}  [1] detail blocks: ${test1 ? '🟢' : '🔴'}  [2] handler reuse: ${test2 ? '🟢' : '🔴'}  [3] QR gate: ${test3 ? '🟢' : '🔴'}  [4] no $/billing: ${test4 ? '🟢' : '🔴'}  [5] no new mutation: ${test5 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

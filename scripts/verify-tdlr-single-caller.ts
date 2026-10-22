// ════════════════════════════════════════════════════════════════════
// GATE — update_my_company_tdlr has exactly ONE reachable UI caller
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY. Two CA surfaces wrote the TDLR licence number through the same
// RPC. One is live, in Billing → Company info, where Jose locked the
// placement. The other sat under Manage → Company and could not be
// reached by anyone: the only button that set manageSection to 'company'
// lived inside the !CA_CRM_REDESIGN block, and that flag is true. It was
// the third casualty of that dead branch, after the 09-16 assign-drivers
// panel and the 09-17 Plate Activity tab — and this one mattered more
// than a lost feature, because a review of the help docs concluded that
// company admins could not set their own TDLR number at all. The dead
// copy made a live capability look absent.
//
// Asserting the COUNT is the point. "At least one caller exists" would
// have been green the whole time the dead panel was there.
//
// Usage: npx tsx scripts/verify-tdlr-single-caller.ts

import fs from 'fs'
import { deadRanges, isDead } from './lib/dead-branch'

const FILE = 'app/company_admin/page.tsx'
const FLAG = 'CA_CRM_REDESIGN'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

console.log('\n══ TDLR write surface: one caller, and it is reachable ══\n')

const src = fs.readFileSync(FILE, 'utf8')
const lines = src.split('\n')
const ranges = deadRanges(lines, FLAG)

// 🔴 If the flag itself vanished, this gate stopped measuring anything.
// Absence must not read as a pass.
if (!src.includes(FLAG)) {
  chk(`🔴 ${FLAG} still exists in ${FILE}`, false,
    '🔴 NOT EXERCISED: the flag is gone, so "not in a dead branch" is vacuously true for every line')
} else {
  chk(`${FLAG} found, ${ranges.length} dead block(s) mapped`, true,
    ranges.map(([a, b]) => `${a}-${b}`).join(', ') || 'none')
}

// ── exactly one caller ──────────────────────────────────────────────
const callers: number[] = []
lines.forEach((l, i) => { if (l.includes("rpc('update_my_company_tdlr'")) callers.push(i + 1) })
chk('🔴 exactly one UI caller of update_my_company_tdlr', callers.length === 1,
  callers.length === 1 ? `line ${callers[0]}` : `found ${callers.length}: ${callers.join(', ')}`)

// ── and it is reachable ─────────────────────────────────────────────
if (callers.length === 1) {
  const dead = isDead(callers[0], ranges)
  chk('🔴 that caller is NOT inside a dead branch', !dead,
    dead ? `line ${callers[0]} is inside a !${FLAG} block — it can never render`
         : `line ${callers[0]} is live`)
} else {
  chk('🔴 that caller is NOT inside a dead branch', false,
    '🔴 NOT EXERCISED: caller count is not 1, so there is no single caller to locate')
}

// ── the dead panel's routing cannot come back ───────────────────────
chk("no manageSection === 'company' panel remains",
  !src.includes("manageSection === 'company'"),
  src.includes("manageSection === 'company'") ? '🔴 the dead panel is back' : 'gone')

const union = lines.find(l => l.includes('const [manageSection')) ?? ''
chk("'company' is no longer a routable manageSection value",
  !union.includes("'company'"), union.trim().slice(0, 120))

const setters = lines.filter(l => l.includes('setManageSection(') && l.includes("'company'"))
chk('nothing routes to company', setters.length === 0,
  setters.length ? `🔴 ${setters.length} setter(s) still target it` : 'no setter targets it')

// ── the surviving surface is the one Jose placed ────────────────────
chk('the surviving field is the Billing → Company info panel',
  src.includes('Company info panel folded into Billing'),
  'the placement lock comment is still on it')

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
process.exit(fails ? 1 : 0)

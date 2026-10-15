// ════════════════════════════════════════════════════════════════════
// derive-rehearsal — the fixture the rehearsal can actually finish on
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. The rehearsal has to end in a real claim email
// arriving, and the Alden fixture cannot do that.
//
// 🔴 WHY A VARIANT AND NOT AN EDIT. alden_fixture_clean.csv is the
// architect's file and the rehearsal's expectations are published
// against it. Changing its addresses would silently change what
// rehearse:bulk and verify:bulkhttp are asserting. So this derives a
// third file and leaves both originals alone, the same way
// alden_fixture_clean.csv was derived from the dirty one.
//
// 🔴 WHAT MEASUREMENT FORCED THIS. Claiming a loaded resident on
// resident001@example.com reached inviteUserByEmail and came back
//   AuthApiError: Error sending invite email (500 unexpected_failure)
// All 228 of the fixture's addresses are @example.com, an RFC 2606
// reserved domain this project's mail provider refuses. @test.invalid
// is accepted by the same provider — verify:claim creates auth users on
// it — so it is the fixture, not the product.
//
// So: the first 3 rows get Jose's plus-addresses, which reach a real
// mailbox he reads, and every other row gets @test.invalid, which the
// provider accepts and no human ever reads.
//
// 🔴 PLUS-ADDRESSING KEEPS ONE MAILBOX AND THREE IDENTITIES.
// jose+bulkload1@ and jose+bulkload2@ are distinct addresses to every
// uniqueness rule in the system — the residents row, the one-email-one
// -role index, auth.users — and the same inbox to Jose. Without that,
// three deliverable testers would mean three real mailboxes.
//
// 🔴 AND THE ROW GROUPING IS PRESERVED. The file has 358 rows and 228
// residents, so some addresses repeat across rows — a resident with two
// cars. Rewriting addresses row-by-row would split those residents and
// change the 228/358 counts the whole arc asserts. So the mapping is
// per DISTINCT ADDRESS, in first-appearance order, and the counts come
// out identical.
//
// Usage: npx tsx docs/bulk-onboarding/fixtures/derive-rehearsal.ts

import fs from 'fs'
import path from 'path'
import { parseBulkCsv, BULK_CSV_COLUMNS, BULK_CSV_HEADER } from '../../../app/lib/bulk-onboarding'

const DIR = path.dirname(new URL(import.meta.url).pathname)
const SRC = path.join(DIR, 'alden_fixture_clean.csv')
const OUT = path.join(DIR, 'alden_fixture_rehearsal.csv')

// The deliverable ones. Jose reads this mailbox; the plus-tag makes
// each a distinct identity to every uniqueness rule in the system.
//
// 🔴 GMAIL, NOT shieldmylot.com. The first rehearsal sent its invite to
// jose+bulkload1@shieldmylot.com and it went nowhere — that mailbox does
// not exist. The claim screen says the same thing either way by design,
// so nothing on the way through showed it; the only evidence was that
// no email arrived.
//
// The lesson is narrower than "use a real address": a send that lands
// nowhere is INDISTINGUISHABLE from one that lands, both to the person
// claiming and to the gate, because the identical-answer rule is doing
// exactly what it was built to do. A rehearsal whose whole purpose is
// "an email arrives" has to use a mailbox someone actually reads, and
// the only way to know is for them to look.
const DELIVERABLE = [
  'alvaradolegacyconsulting+bulkload1@gmail.com',
  'alvaradolegacyconsulting+bulkload2@gmail.com',
  'alvaradolegacyconsulting+bulkload3@gmail.com',
]

const text = fs.readFileSync(SRC, 'utf8')
const parsed = parseBulkCsv(text)
if (!parsed.ok) { console.error(`🔴 ${SRC} does not parse: ${parsed.code} ${parsed.message}`); process.exit(1) }

const ei = BULK_CSV_COLUMNS.indexOf('email')
const norm = (s: string) => s.trim().toLowerCase()

// Distinct addresses in first-appearance order, so the first three
// deliverable ones land on the first three RESIDENTS rather than the
// first three rows.
const order: string[] = []
const seen = new Set<string>()
for (const r of parsed.dataRows) {
  const e = norm(r[ei] ?? '')
  if (e && !seen.has(e)) { seen.add(e); order.push(e) }
}

const map = new Map<string, string>()
order.forEach((e, i) => {
  map.set(e, i < DELIVERABLE.length
    ? DELIVERABLE[i]
    // Stable and derived from the original, so re-running produces the
    // same file and a diff shows only what changed.
    : `${e.split('@')[0]}@test.invalid`)
})

const rows = parsed.dataRows.map(r => {
  const copy = [...r]
  copy[ei] = map.get(norm(r[ei] ?? '')) ?? copy[ei]
  return copy
})

const quote = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
fs.writeFileSync(OUT, [BULK_CSV_HEADER, ...rows.map(r => r.map(quote).join(','))].join('\n') + '\n', 'utf8')

// 🔴 Verify the derived file against the original's counts rather than
// trusting the rewrite. A mapping bug that split one resident into two
// would change 228 and break every assertion downstream.
const back = parseBulkCsv(fs.readFileSync(OUT, 'utf8'))
if (!back.ok) { console.error(`🔴 the derived file does not parse: ${back.code}`); process.exit(1) }
const same = back.dataRows.length === parsed.dataRows.length
  && back.residentCount === parsed.residentCount
  && back.vehicleCount === parsed.vehicleCount
console.log(`${path.basename(SRC)}  ${parsed.dataRows.length} rows · ${parsed.residentCount} residents · ${parsed.vehicleCount} vehicles`)
console.log(`${path.basename(OUT)}  ${back.dataRows.length} rows · ${back.residentCount} residents · ${back.vehicleCount} vehicles`)
console.log(same ? '✅ counts identical — the rewrite was per distinct address, so no resident was split'
                 : '🔴 COUNTS DIFFER — the address mapping split or merged a resident')
const deliverableRows = rows.filter(r => DELIVERABLE.includes(r[ei]))
console.log(`\ndeliverable addresses on ${deliverableRows.length} row(s):`)
for (const e of DELIVERABLE) {
  const n = rows.filter(r => r[ei] === e).length
  console.log(`   ${e.padEnd(36)} ${n} row(s)`)
}
const stray = rows.filter(r => !/@test\.invalid$/.test(r[ei]) && !DELIVERABLE.includes(r[ei]))
console.log(stray.length === 0
  ? '✅ every other address is @test.invalid — no third party can be mailed by a rehearsal'
  : `🔴 ${stray.length} row(s) carry neither a deliverable nor a @test.invalid address: ${stray.slice(0,3).map(r=>r[ei]).join(', ')}`)
process.exit(same && stray.length === 0 ? 0 : 1)

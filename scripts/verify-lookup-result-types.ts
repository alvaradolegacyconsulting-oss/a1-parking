// ════════════════════════════════════════════════════════════════════
// GATE — every pm_plate_lookup result_type is handled by the client
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY THIS EXISTS. pm_plate_lookup has been able to return
// 'do_not_tow' since the do-not-tow branch shipped, and it was never in
// the manager's result_type whitelist — so it degraded to "Unexpected
// response from server." on the most protective status in the system.
// It went unnoticed for months because do_not_tow_plates is empty, and
// because the only thing guarding the list was a COMMENT asking the
// next person to remember.
//
// A comment is not a gate. This reads the migration that defines the
// function, extracts every result_type it can assign, and proves each
// one is (a) whitelisted, (b) rendered, and (c) in the PlateStatus
// union. Static — no DB needed, so it can run in any environment.
//
// Usage: npm run verify:lookuptypes

import fs from 'fs'
import path from 'path'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

// The migration that currently defines the function. Preferring
// migrations/ (applied) over docs/backlog/ (draft), and failing loudly
// rather than silently checking nothing if neither is present.
const CANDIDATES = [
  'migrations/20261013_piece1_partB_pm_plate_lookup_tags.sql',
  'docs/backlog/wip-20261013_piece1_partB_pm_plate_lookup_tags.sql',
]
const sqlPath = CANDIDATES.find(p => fs.existsSync(path.resolve(p)))
if (!sqlPath) {
  console.error('🔴 Could not find the pm_plate_lookup migration in either location:')
  for (const c of CANDIDATES) console.error(`   ${c}`)
  console.error('   Refusing to pass: absence of the source is not proof the client is correct.')
  process.exit(2)
}
console.log(`source of truth: ${sqlPath}\n`)

const sql = fs.readFileSync(sqlPath, 'utf8')
const mgr = fs.readFileSync('app/manager/page.tsx', 'utf8')
const meta = fs.readFileSync('app/lib/plate-status.ts', 'utf8')

// Every value the function can assign to v_result_type.
const types = [...new Set([...sql.matchAll(/v_result_type\s*:=\s*'([a-z_]+)'/g)].map(m => m[1]))].sort()
chk(`extracted result_types from the migration (${types.length})`, types.length >= 9, types.join(', '))
if (types.length < 9) {
  console.error('🔴 Too few result_types found — the extraction regex has probably drifted from the SQL.')
  console.error('   Passing on a short list would be worse than failing: it would certify a list it never read.')
  process.exit(2)
}

// The manager's whitelist is a chain of `kind !== 'x'` tests.
const whitelisted = new Set([...mgr.matchAll(/kind\s*!==\s*'([a-z_]+)'/g)].map(m => m[1]))
// A render branch is `result_type === 'x'`.
const rendered = new Set([...mgr.matchAll(/result_type\s*===\s*'([a-z_]+)'/g)].map(m => m[1]))
// The shared union.
const unionBlock = meta.split('export type PlateStatus')[1]?.split('export type PlateSurface')[0] ?? ''
const union = new Set([...unionBlock.matchAll(/\|\s*'([a-z_]+)'/g)].map(m => m[1]))

// 🔴 A NARROW, NAMED MAPPING — not a loosened check. The RPC's
// vocabulary and the UI's are not identical: the function returns
// 'resident' and the UI badge vocabulary calls that state 'authorized'
// (PLATE_STATUS_META.authorized). That is one deliberate rename, so it
// is written down as one entry. Anything NOT in this map must appear in
// PlateStatus under its own name — the alternative, skipping the union
// check whenever it fails, would have let do_not_tow through again.
const RPC_TO_UI_STATUS: Record<string, string> = {
  resident: 'authorized',
}

console.log('\n── each result_type must be whitelisted, rendered, and in the union ──')
for (const t of types) {
  const uiName = RPC_TO_UI_STATUS[t] ?? t
  const w = whitelisted.has(t), r = rendered.has(t), u = union.has(uiName)
  chk(`${t.padEnd(20)} whitelist=${w ? 'yes' : 'NO'} render=${r ? 'yes' : 'NO'} union=${u ? 'yes' : 'NO'}${uiName !== t ? ` (as '${uiName}')` : ''}`,
    w && r && u,
    !w ? '🔴 unlisted types degrade to "Unexpected response from server."'
      : !r ? '🔴 whitelisted but NOT rendered — the user gets a blank panel, which is worse than an error'
      : !u ? `🔴 '${uiName}' missing from PlateStatus, so PLATE_STATUS_META has no entry for it`
      : '')
}

// 🔴 POSITIVE CONTROL. Every check above is "the client covers the SQL".
// A client that whitelisted every conceivable string would pass them
// all. This asserts the converse: the client must not claim to handle a
// type the function cannot produce, which is how a stale type lingers
// after a branch is removed.
console.log('\n── CONTROL: the rename map points at real statuses ──')
for (const [rpcName, uiName] of Object.entries(RPC_TO_UI_STATUS)) {
  chk(`rename '${rpcName}' -> '${uiName}' targets a real PlateStatus`, union.has(uiName),
    union.has(uiName) ? '' : `🔴 '${uiName}' is not in the union — the map is papering over a missing status`)
  chk(`rename '${rpcName}' is a type the RPC actually returns`, types.includes(rpcName),
    types.includes(rpcName) ? '' : `🔴 the RPC never returns '${rpcName}' — stale map entry`)
}

console.log('\n── CONTROL: the client must not handle types the RPC cannot return ──')
const KNOWN_CLIENT_ONLY = new Set([
  'notfound',          // driver's client-side cascade equivalent of unauthorized
  'otherproperty',     // CA surface only
  'authorized',        // UI label for the RPC's 'resident'
  'declined', 'expired',
])
const stale = [...whitelisted].filter(t => !types.includes(t) && !KNOWN_CLIENT_ONLY.has(t))
chk('no stale types in the manager whitelist', stale.length === 0,
  stale.length ? `${stale.join(', ')} — the RPC cannot return these` : 'none')

console.log('')
if (fails) {
  console.log(`❌ ${fails} FAILURE(S). A result_type the client does not handle reaches the user as an error or a blank panel.`)
  process.exit(1)
}
console.log('✅ Every pm_plate_lookup result_type is whitelisted, rendered, and backed by PLATE_STATUS_META.')

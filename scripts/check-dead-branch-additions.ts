// ════════════════════════════════════════════════════════════════════
// check-dead-branch-additions — refuse work that lands in a dead branch.
//
//   npx tsx scripts/check-dead-branch-additions.ts            # working tree vs HEAD
//   npx tsx scripts/check-dead-branch-additions.ts <sha>      # one commit
//
// Exit 0 = clean, 1 = additions inside a !CA_CRM_REDESIGN block.
//
// ── WHY A CHECK AND NOT JUST A COMMENT ─────────────────────────────
// The banner comments at each block opening are 50+ lines from where a
// grep hit lands, which is exactly why two features were lost anyway.
// Markers deeper inside are NOT possible: JSX comments are only valid
// at child positions, and the dead blocks contain arrow-function bodies
// and expression contexts where one breaks the parse. That was tried on
// 2026-09-17 and broke the build.
//
// So the durable guard is this: it does not rely on anyone reading
// anything. It answers at the moment the mistake is made, which is the
// only moment the answer is cheap.
//
// 🔴 A HIT IS NOT AUTOMATICALLY WRONG. Parallel maintenance — the same
// change applied to BOTH branches — is correct and common: the audit on
// 2026-09-17 found five such commits (confirm-email, deactivation
// severity, the timezone sweep, the pm_starter portal fix) and every one
// of them was right. The failure mode is an addition that lands ONLY in
// the dead branch. This prints both counts so the difference is visible
// rather than assumed.
// ════════════════════════════════════════════════════════════════════
import { execFileSync } from 'child_process'

// 🔴 TWO files, two flags. The manager portal has the SAME pattern and
// was NOT covered: PM_CRM_ENABLED is true, so everything behind
// !PM_CRM_ENABLED — the legacy residents AND vehicles blocks — never
// renders. A parking-tag field was mounted in that dead block on
// 2026-10-13 and shipped invisible; the CA gate could not see it
// because it only ever read one file. Any new always-on flag of this
// shape belongs here the day it is introduced.
const TARGETS: { file: string; flag: string }[] = [
  { file: 'app/company_admin/page.tsx', flag: 'CA_CRM_REDESIGN' },
  { file: 'app/manager/page.tsx',       flag: 'PM_CRM_ENABLED'  },
]
const sha = process.argv[2]

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** Line ranges (1-indexed, inclusive) inside a !<flag> block. */
function deadRanges(lines: string[], flag: string): [number, number][] {
  const out: [number, number][] = []
  lines.forEach((l, i) => {
    if (!l.includes(`!${flag} &&`)) return
    let depth = 0, started = false
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length
      if (!started && depth > 0) started = true
      if (started && depth <= 0) { out.push([i + 1, j + 1]); return }
    }
  })
  return out
}

/** New-file line numbers of added lines, with their text. */
function addedLines(diff: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = []
  let cur: number | null = null
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) { cur = Number(m[1]); continue }
    if (cur === null) continue
    if (line.startsWith('+') && !line.startsWith('+++')) { out.push({ n: cur, text: line.slice(1) }); cur++ }
    else if (line.startsWith(' ')) cur++
  }
  return out
}

let anyDead = false
let checked = 0

for (const { file, flag } of TARGETS) {
  // Ranges are computed from the version the added line numbers refer to.
  const after = sha ? git('show', `${sha}:${file}`) : require('fs').readFileSync(file, 'utf8')
  const ranges = deadRanges(after.split('\n'), flag)

  // 🔴 A file whose flag guard has VANISHED is not "clean" — it means
  // the flag was renamed or removed and this gate silently stopped
  // checking anything. Absence must not be the pass.
  if (ranges.length === 0 && !after.includes(flag)) {
    console.log(`🔴 ${file}: no \`${flag}\` found at all. Either the flag was renamed — update TARGETS —`)
    console.log('   or the dead branch was deleted, in which case drop it from TARGETS deliberately.')
    anyDead = true
    continue
  }

  const diff = sha
    ? git('show', '--unified=0', '--format=', sha, '--', file)
    : git('diff', '--unified=0', 'HEAD', '--', file)

  const adds = addedLines(diff)
  if (adds.length === 0) { console.log(`no additions to ${file}`); continue }
  checked++

  const inDead = adds.filter(a => ranges.some(([x, y]) => a.n >= x && a.n <= y))
  const inLive = adds.length - inDead.length
  console.log(`${file}: ${adds.length} added line(s) — ${inLive} live, ${inDead.length} in a dead (!${flag}) branch`)

  if (inDead.length === 0) { console.log(`   ✅ nothing landed in a !${flag} block`); continue }
  anyDead = true

  console.log(`\n🔴 ${inDead.length} added line(s) are inside a !${flag} block and WILL NEVER RENDER:\n`)
  for (const a of inDead.slice(0, 15)) console.log(`   ${a.n}: ${a.text.trim().slice(0, 96)}`)
  if (inDead.length > 15) console.log(`   … and ${inDead.length - 15} more`)
  console.log(
    inLive > 0
      ? '\n⚠ There are live additions too, so this MAY be deliberate parallel maintenance —\n' +
        '  the same change applied to both branches, which is correct. Confirm that is what\n' +
        '  this is. If the dead lines are the only copy of something, they shipped nowhere.'
      : `\n🔴 EVERY added line in ${file} is in a dead branch. None of it will render.`,
  )
}

if (anyDead) process.exit(1)
console.log(checked === 0 ? 'no additions to either CRM file' : '✅ all additions are in live branches')
process.exit(0)

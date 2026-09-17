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

const FILE = 'app/company_admin/page.tsx'
const sha = process.argv[2]

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** Line ranges (1-indexed, inclusive) inside a !CA_CRM_REDESIGN block. */
function deadRanges(lines: string[]): [number, number][] {
  const out: [number, number][] = []
  lines.forEach((l, i) => {
    if (!l.includes('!CA_CRM_REDESIGN &&')) return
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

const content = sha ? git('show', `${sha}:${FILE}`) : git('show', `HEAD:${FILE}`)
// Ranges are computed from the version the added line numbers refer to.
const after = sha ? git('show', `${sha}:${FILE}`) : require('fs').readFileSync(FILE, 'utf8')
const ranges = deadRanges(after.split('\n'))

const diff = sha
  ? git('show', '--unified=0', '--format=', sha, '--', FILE)
  : git('diff', '--unified=0', 'HEAD', '--', FILE)

const adds = addedLines(diff)
if (adds.length === 0) { console.log('no additions to', FILE); process.exit(0) }

const inDead = adds.filter(a => ranges.some(([x, y]) => a.n >= x && a.n <= y))
const inLive = adds.length - inDead.length

console.log(`${FILE}: ${adds.length} added line(s) — ${inLive} live, ${inDead.length} in a dead branch`)

if (inDead.length === 0) { console.log('✅ nothing landed in a !CA_CRM_REDESIGN block'); process.exit(0) }

console.log(`\n🔴 ${inDead.length} added line(s) are inside a !CA_CRM_REDESIGN block and WILL NEVER RENDER:\n`)
for (const a of inDead.slice(0, 15)) console.log(`   ${a.n}: ${a.text.trim().slice(0, 96)}`)
if (inDead.length > 15) console.log(`   … and ${inDead.length - 15} more`)

console.log(
  inLive > 0
    ? '\n⚠ There are live additions too, so this MAY be deliberate parallel maintenance —\n' +
      '  the same change applied to both branches, which is correct. Confirm that is what\n' +
      '  this is. If the dead lines are the only copy of something, they shipped nowhere.'
    : '\n🔴 EVERY added line is in a dead branch. Nothing in this change will render.',
)
process.exit(1)

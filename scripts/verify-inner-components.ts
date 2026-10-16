// ════════════════════════════════════════════════════════════════════
// GATE — no component may be declared inside another component's body
// ════════════════════════════════════════════════════════════════════
//
// THE BUG THIS EXISTS FOR (2026-10-15). On the resident-upload page,
// step 5's "Your name" and "Your title" inputs lost focus after every
// single keystroke. The inputs were ordinary controlled inputs and
// looked correct. The defect was 160 lines away, at a DECLARATION SITE:
//
//   export default function ResidentUploadPage() {
//     const Shell = ({ children }) => (<main>…</main>)   // ← here
//     const Card  = ({ children }) => (<section>…</section>)
//
// A component declared inside a component is a NEW FUNCTION OBJECT on
// every render. React compares element types by identity, so <Shell>
// was a different type each time: the reconciler unmounted the entire
// subtree and mounted a fresh one instead of updating it. Every
// keystroke destroyed the input the caret was sitting in.
//
// 🔴 WHY THIS IS A STATIC GATE AND NOT A FOCUS TEST. The real assertion
// is "type into the field, the caret stays". That is a reconciler
// behaviour over two renders, and it needs jsdom + @testing-library or
// Playwright; neither is installed (see verify-crm-remount-keys.ts,
// which hit the same wall for the same reason). renderToStaticMarkup
// cannot help: it only ever performs a FIRST render, and a first render
// of this page looked perfect. So this gate catches the cause instead
// of the symptom — which has one advantage over the focus test it
// stands in for: it fires on the NEXT such declaration too, including
// ones whose remount shows up as lost scroll position, a restarted
// animation, or a re-fired useEffect rather than as a lost caret.
//
// 🔴 THE ALLOWLIST IS AN ARGUMENT, NOT A MUTE. Every exemption states
// why that declaration's remount is harmless. An exemption with no
// reason is how a gate becomes decoration.
//
// Usage: npm run verify:innercomponents

import fs from 'fs'
import path from 'path'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

/** Declarations whose remount costs nothing, each with the reason. */
const ALLOW: Record<string, string> = {
  'app/admin_console/page.tsx:SortArrow': 'renders one <span> holding a sort glyph (↕ ↑ ↓). It contains nothing focusable, no state, no effect and no scroll position, so a remount is indistinguishable from an update. Hoisting it would mean threading ppSortCol/ppSortDir through props for no behavioural gain.',
}

// ── strip comments ──────────────────────────────────────────────────
// 🔴 A COMMENT MUST NOT BE ABLE TO ANSWER OR DEFEAT A SOURCE-TEXT
// ASSERTION. This gate's own subject file carries a comment that
// quotes the broken declaration it fixed; left in, that comment is a
// violation. Blank the comment bodies but KEEP the line count, so
// every report still cites the real line number.
function stripComments(src: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = ''
    let i = 0
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i)
        if (end === -1) { i = raw.length } else { inBlock = false; i = end + 2 }
        continue
      }
      if (raw.startsWith('//', i)) break
      if (raw.startsWith('/*', i)) { inBlock = true; i += 2; continue }
      line += raw[i]; i += 1
    }
    out.push(line)
  }
  return out
}

function tsxFiles(dir: string): string[] {
  const found: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') found.push(...tsxFiles(p)) }
    else if (e.name.endsWith('.tsx')) found.push(p)
  }
  return found.sort()
}

// A component declaration: CamelCase name (at least one lowercase, so
// SCREAMING_CASE constants are not candidates), declared at an indent
// greater than zero, with JSX in the first lines of its body.
const ARROW = /^\s+(?:const|let)\s+([A-Z][A-Za-z0-9]*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/
const FUNC = /^\s+function\s+([A-Z][A-Za-z0-9]*)\s*[(<]/
const JSXISH = /<[A-Za-z][A-Za-z0-9.]*[\s/>]|<>/

type Hit = { file: string; line: number; name: string; text: string }

function scan(file: string): Hit[] {
  const lines = stripComments(fs.readFileSync(file, 'utf8'))
  const hits: Hit[] = []
  lines.forEach((l, i) => {
    const m = ARROW.exec(l) ?? FUNC.exec(l)
    if (!m) return
    const name = m[1]
    if (!/[a-z]/.test(name)) return
    if (!JSXISH.test(lines.slice(i, i + 5).join('\n'))) return
    hits.push({ file, line: i + 1, name, text: l.trim().slice(0, 100) })
  })
  return hits
}

async function main() {
  console.log('\n══ no component declared inside another component ══\n')

  const files = tsxFiles('app')
  const hits = files.flatMap(scan)
  const unexplained = hits.filter(h => !(`${h.file}:${h.name}` in ALLOW))

  // 🔴 ASSERT THE POPULATION, NOT JUST THE RESULT. A scan that silently
  // walked zero files reports a clean sweep. State what was searched.
  chk('the sweep actually read the app tree', files.length > 50, `${files.length} .tsx file(s) scanned`)

  chk('🔴 no component is declared inside another component',
    unexplained.length === 0,
    unexplained.length === 0
      ? `${hits.length} declaration(s) found, all ${hits.length} carrying a stated reason`
      : unexplained.map(h => `${h.file}:${h.line}  ${h.name}  — ${h.text}`).join('\n       '))

  for (const h of hits) {
    const why = ALLOW[`${h.file}:${h.name}`]
    if (why) console.log(`   ↪ allowed: ${h.name} (${h.file}:${h.line})\n       ${why}`)
  }

  // ── the regression itself ─────────────────────────────────────────
  // 🔴 NAME THE TWO THAT BROKE. The sweep above would also pass if the
  // upload page were deleted. Assert that Shell and Card still exist
  // and are still at module scope: that is the fix, stated as a fact.
  const UPLOAD = 'app/company_admin/resident-upload/page.tsx'
  const up = stripComments(fs.readFileSync(UPLOAD, 'utf8'))
  for (const name of ['Shell', 'Card']) {
    const atModule = up.some(l => new RegExp(`^function ${name}\\(`).test(l))
    const used = up.some(l => l.includes(`<${name}>`))
    chk(`🔴 ${name} is declared at module scope on the upload page, and still used`,
      atModule && used,
      atModule && used
        ? 'module-level declaration, so its identity is stable across renders'
        : `module-level=${atModule} used=${used}`)
  }

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })

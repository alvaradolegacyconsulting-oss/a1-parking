// ════════════════════════════════════════════════════════════════════
// GATE — a prop-seeded component in a subject-switching panel must be
//        mounted with a key
// ════════════════════════════════════════════════════════════════════
//
// THE BUG THIS EXISTS FOR (2026-10-15). PhysicalPassSwitches seeded its
// state with useState(props), and its mount in the CA Properties panel
// passed no key. useState reads its argument only on FIRST MOUNT, and
// `selected` changes while that panel stays mounted — so the switches
// kept the first property's values. After viewing Northgate, where both
// are on, every property read ON. The database was correct the whole
// time: 1 of 28 properties, A1 0 of 10.
//
// 🔴 THIS GATE IS STATIC, AND THAT IS A LIMITATION, NOT A CHOICE OF
// CONVENIENCE. The requested check — click property A (switch on), then
// property B (switch off), assert B renders B's own values — is a
// RE-RENDER WITH CHANGED PROPS ON A RETAINED INSTANCE. That needs a
// reconciler with state: jsdom + @testing-library, or Playwright.
// Neither is installed (no jest, no vitest, no jsdom, no
// react-test-renderer), and renderToStaticMarkup cannot help because it
// only ever does a FIRST render, which was never the broken case.
//
// Adding a render-test toolchain is worth doing and is Jose's call, not
// something to slip in beside a one-line fix. Until then this gate
// catches the regression at its cause: a prop-seeded component mounted
// without a key, in a file where the subject changes in place.
//
// 🔴 THE ALLOWLIST IS AN ARGUMENT, NOT A MUTE. Every exemption states
// why that mount is safe. An exemption with no reason is how a gate
// becomes decoration.
//
// Usage: npm run verify:remountkeys

import fs from 'fs'
import path from 'path'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

// Files where the SUBJECT changes while the tree stays mounted:
// the CA two-panel Properties CRM (`selected`), the manager page
// (switchProperty → setManager in place), the admin console drawer.
const SUBJECT_SWITCHING = [
  'app/company_admin/page.tsx',
  'app/manager/page.tsx',
  'app/admin_console/page.tsx',
  'app/admin/page.tsx',
  'app/components/PmResidentCrm.tsx',
]

/** Mount sites that need no key, each with the reason it is safe. */
const ALLOW: Record<string, string> = {
  'CredentialsModal': 'rendered as {credentials && …}, so it unmounts when dismissed and re-seeds on the next open',
  'ReapprovalOrphansModal': 'rendered as {reapprovalOrphans && …}; the orphan set is assigned once when opening and the modal unmounts on close',
  'SpaceDetailModal': 'rendered as {targetSpaceDetail && …}; it unmounts between opens, and it re-fetches in a useEffect rather than trusting the seeded prop',
  'SupportContact': 'seeds nothing from props — adminEmails/loaded come from its own useEffect; the regex matches its props line, not an initializer',
  'CaPlateActivityTab': 'rendered as {activeTab === "plate-activity" && …}, so leaving the tab unmounts it; the seeded value is a one-property convenience default, not live state',
}

/** The balanced-paren contents of each useState(...) call. */
function useStateInits(src: string): string[] {
  const out: string[] = []
  for (let i = src.indexOf('useState'); i !== -1; i = src.indexOf('useState', i + 1)) {
    const open = src.indexOf('(', i)
    if (open === -1) continue
    // 🔴 Balanced scan, not a regex. A regex over `useState<Record<A,B>>({…})`
    // either stops at the first ')' or runs past the call into the next
    // statement, and both give a wrong answer about what was seeded.
    let depth = 0, j = open
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') { depth--; if (depth === 0) break }
    }
    out.push(src.slice(open + 1, j))
  }
  return out
}

/** Prop names from the component's own parameter destructuring. */
function propNames(src: string): Set<string> {
  const names = new Set<string>()
  const m = /export default function \w+\(\s*\{([\s\S]*?)\}\s*:/.exec(src)
  if (m) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[:=]/)[0].trim()
      if (/^[A-Za-z_]\w*$/.test(n)) names.add(n)
    }
  }
  return names
}

const main = () => {
  const comps = fs.readdirSync('app/components').filter(f => f.endsWith('.tsx'))
  const seeded: Record<string, string[]> = {}
  for (const f of comps) {
    const src = fs.readFileSync(path.join('app/components', f), 'utf8')
    const props = propNames(src)
    if (!props.size) continue
    const hits = new Set<string>()
    for (const init of useStateInits(src)) {
      for (const p of props) if (new RegExp(`\\b${p}\\b`).test(init)) hits.add(p)
    }
    if (hits.size) seeded[f.replace(/\.tsx$/, '')] = [...hits].sort()
  }

  console.log(`── components that seed useState from a prop: ${Object.keys(seeded).length} ──`)
  for (const [c, props] of Object.entries(seeded)) console.log(`   ${c.padEnd(26)} ← ${props.join(', ')}`)

  console.log('\n── their mounts in files where the subject changes in place ──')
  let checked = 0
  for (const [comp, props] of Object.entries(seeded)) {
    for (const file of SUBJECT_SWITCHING) {
      if (!fs.existsSync(file)) continue
      const src = fs.readFileSync(file, 'utf8')
      const re = new RegExp(`<${comp}\\b([\\s\\S]{0,500}?)(?:/>|>)`, 'g')
      let m: RegExpExecArray | null
      let n = 0
      while ((m = re.exec(src)) !== null) {
        n++
        checked++
        const hasKey = /\bkey=/.test(m[1])
        const line = src.slice(0, m.index).split('\n').length
        const where = `${path.basename(file)}:${line}`
        if (hasKey) {
          chk(`${comp} @ ${where}`.padEnd(58) + 'key present', true, `seeds ${props.join(', ')}`)
        } else if (ALLOW[comp]) {
          chk(`${comp} @ ${where}`.padEnd(58) + 'exempt', true, ALLOW[comp])
        } else {
          chk(`${comp} @ ${where}`.padEnd(58) + '🔴 NO KEY', false,
            `seeds ${props.join(', ')} from props and is mounted where the subject changes in place. Add key={<subject>.id}, or add an ALLOW entry saying why it is safe.`)
        }
      }
      if (n === 0) { /* not mounted here */ }
    }
  }
  chk('every prop-seeded component in those files was examined', checked > 0, `${checked} mount(s)`)

  // 🔴 The three fixed on 2026-10-15, asserted by name. The generic rule
  // above would also catch them, but naming them means a future
  // "simplification" that drops one fails with the reason attached
  // rather than as an anonymous count.
  console.log('\n── the four fixed on 2026-10-15, by name ──')
  const named: [string, string, string][] = [
    ['app/company_admin/page.tsx', 'PhysicalPassSwitches', 'selected.id'],
    ['app/company_admin/page.tsx', 'AuthorizedPlatesManager', 'selected.id'],
    ['app/manager/page.tsx', 'AuthorizedPlatesManager', 'manager.id'],
    // 🔴 The fourth. MISSED by the hand sweep and caught by this gate on
    // its first run — the manager portal had the same PhysicalPassSwitches
    // defect, read-only, which makes a wrong value harder to disbelieve.
    ['app/manager/page.tsx', 'PhysicalPassSwitches', 'manager.id'],
  ]
  for (const [file, comp, keyExpr] of named) {
    const src = fs.readFileSync(file, 'utf8')
    const re = new RegExp(`<${comp}\\b[\\s\\S]{0,400}?key=\\{${keyExpr.replace('.', '\\.')}\\}`)
    chk(`${comp} @ ${path.basename(file)} still keyed on ${keyExpr}`, re.test(src),
      re.test(src) ? 'ok' : `🔴 the key is gone — this is the Northgate bug, restored`)
  }

  console.log(`\n${fails === 0 ? '✅ all green (static — see the header for what this cannot prove)' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

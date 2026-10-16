// ════════════════════════════════════════════════════════════════════
// GATE — the Bulk imports badge counts work, not history
// ════════════════════════════════════════════════════════════════════
//
// Ruled 2026-10-16: the badge counts `submitted` + `approved` only.
// Loaded-but-rollbackable batches are never counted.
//
// 🔴 WHY THAT RULING NEEDS A GATE AT ALL. The tempting change is to
// include `loaded`, so an operator sees that a rollback is still
// possible. It would make the badge non-zero from every load until
// midnight, every day — and a badge that is always lit is how a signal
// becomes wallpaper. "Waiting" means something is REQUIRED of the
// operator: a decision (submitted) or a load (approved). A rollback is
// an option, not a task.
//
// 🔴 AND WHY IT IS A SOURCE-TEXT GATE. The count comes from one query
// inside a Promise.all in a client component; there is no server
// surface to call and no render test installed. So this pins the query
// itself. Narrow on purpose: it asserts the status list and that the
// setter is actually reached, which are the two ways the ruling can be
// lost.
//
// 🔴 It also exists because I reported this badge as dead code and was
// wrong. Two flawed searches agreed with each other — one truncated by
// `head`, one case-sensitive against `setAwaitingReview` — and I
// published the conclusion. A gate is how that stops being a matter of
// who grepped carefully.
//
// Usage: npm run verify:importbadge

import fs from 'fs'

const FILE = 'app/admin_console/page.tsx'
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

/** Blank comment bodies, keep line numbers. */
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

function main() {
  console.log('\n══ Bulk imports badge counts submitted + approved ══\n')
  const lines = stripComments(fs.readFileSync(FILE, 'utf8'))
  const src = lines.join('\n')

  // The query. Matched on the table and the .in() list together, so a
  // different import_batches read elsewhere in the file cannot satisfy it.
  const queryRe = /from\('import_batches'\)[\s\S]{0,120}?\.in\(\s*'status'\s*,\s*\[([^\]]*)\]\s*\)/
  const m = queryRe.exec(src)
  chk('the badge query exists and filters on a status list',
    !!m, m ? `found: .in('status', [${m[1].trim()}])` : '🔴 no import_batches .in(status, …) query in the file')

  if (m) {
    const got = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort()
    const want = ['approved', 'submitted']
    chk("🔴 it is exactly ['submitted','approved'] — no 'loaded'",
      got.join(',') === want.join(','),
      got.join(',') === want.join(',')
        ? `['${got.join("','")}']`
        : `🔴 got ['${got.join("','")}'] — a badge counting loaded batches is lit from every load until midnight`)
  }

  // 🔴 The setter must be REACHED, not merely declared. This is the
  // exact thing I got wrong: state plus a render site, with no call,
  // paints nothing — and state plus a call is the whole mechanism.
  const declared = /const \[\s*awaitingReview\s*,\s*setAwaitingReview\s*\]\s*=\s*useState/.test(src)
  const callLines = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(x => /setAwaitingReview\s*\(/.test(x.l))
  chk('awaitingReview is declared', declared)
  chk('🔴 setAwaitingReview is actually CALLED, not just declared',
    callLines.length >= 1,
    callLines.length
      ? callLines.map(x => `${FILE}:${x.n}`).join(', ')
      : '🔴 declared and rendered but never set — the badge would paint nothing, forever')

  // And the pill still renders from it, hidden at zero.
  chk('the pill renders only when the count is above zero',
    /awaitingReview\s*>\s*0\s*&&/.test(src),
    'hidden at zero, because a badge that is always there stops being a signal')

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

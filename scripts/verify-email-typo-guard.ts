// ════════════════════════════════════════════════════════════════════
// GATE — email typo guard (2026-09-21)
// ════════════════════════════════════════════════════════════════════
// Jose's five cases, plus the ones that prove the guard is not simply
// refusing everything. The last three are the assertions that matter:
// a validator that rejects all input passes case 1 on its own.
import { guardEmail, checkDeadTld, suggestEmailCorrection, normalizeEmail } from '../app/lib/email-guard'

let failures = 0
const pass = (id: string, n: string) => console.log(`✅ ${id}  ${n}`)
const fail = (id: string, n: string) => { failures++; console.log(`❌ ${id}  ${n}`) }

// ── G1 — dead TLD refused by the SERVER-SIDE gate, message names .com ──
{
  const r = guardEmail('name@gmail.con')
  if (!r.ok && /\.con/.test(r.message) && /\.com/.test(r.message)) pass('G1', `refused: "${r.message}"`)
  else fail('G1', `expected a refusal naming .con and .com, got ${JSON.stringify(r)}`)
}

// ── G2 — suggest class is NOT server-enforced ────────────────────────
{
  const r = guardEmail('name@gmail.co')
  const s = suggestEmailCorrection('name@gmail.co')
  if (r.ok && s === 'name@gmail.com') pass('G2', `server ACCEPTS gmail.co; form suggests "${s}"`)
  else fail('G2', `guardEmail=${JSON.stringify(r)} suggestion=${JSON.stringify(s)}`)
}

// ── G3 — 🔴 the real-TLD case. .co / .cm / .om are Colombia, Cameroon, Oman ──
for (const addr of ['name@example.co', 'name@example.cm', 'name@example.om', 'name@company.co.uk']) {
  const r = guardEmail(addr)
  if (r.ok) pass('G3', `${addr} accepted — real TLD not blocked`)
  else fail('G3', `🔴 ${addr} was REFUSED: ${r.message}`)
}
{
  // ...and no spurious suggestion on them either.
  const s = suggestEmailCorrection('name@example.co')
  if (s === null) pass('G3b', 'example.co produces no bogus suggestion')
  else fail('G3b', `example.co suggested ${JSON.stringify(s)}`)
}

// ── G4 — 🔴 POSITIVE CONTROL. The ordinary address must pass. ────────
for (const addr of ['name@gmail.com', 'greth.plancarte@gmail.com', 'amanda.a1wreckerll+greenacres@gmail.com',
                    'john_smith@gmail.com', 'fred.sugarberry@gmail.com', 'a@b.io']) {
  const r = guardEmail(addr)
  const s = suggestEmailCorrection(addr)
  if (r.ok && s === null) pass('G4', `${addr} accepted, no suggestion`)
  else fail('G4', `🔴 ${addr} guard=${JSON.stringify(r)} suggestion=${JSON.stringify(s)}`)
}

// ── G5 — trim + lower-case, matching lower(trim(email)) everywhere else ──
{
  const n = normalizeEmail('  Name@Gmail.com  ')
  const r = guardEmail('  Name@Gmail.com  ')
  if (n === 'name@gmail.com' && r.ok) pass('G5', `"  Name@Gmail.com  " → "${n}", accepted`)
  else fail('G5', `normalize=${JSON.stringify(n)} guard=${JSON.stringify(r)}`)
}

// ── G6 — the metachar tourniquet still works (not broken by the merge) ──
{
  const r = guardEmail('%@gmail.com')
  if (!r.ok && r.char === '%') pass('G6', 'the 2026-09-11 wildcard tourniquet still fires')
  else fail('G6', `wildcard guard regressed: ${JSON.stringify(r)}`)
}
{
  const r = guardEmail('john_smith@gmail.com')
  if (r.ok) pass('G6b', 'underscore still DELIBERATELY allowed (11 live accounts carry one)')
  else fail('G6b', `underscore now refused — this locks out ~5% of accounts: ${r.message}`)
}

// ── G7 — every dead TLD in the list actually fires, and .com does not ──
{
  const bad = ['con','cmo','ocm','cpm','vom','xom','comm','coom']
  const missed = bad.filter(t => checkDeadTld(`a@b.${t}`).ok)
  if (missed.length === 0) pass('G7', `all ${bad.length} dead TLDs refused`)
  else fail('G7', `these did NOT fire: ${missed.join(', ')}`)
  const trailing = checkDeadTld('a@gmail.com.')
  if (!trailing.ok) pass('G7b', 'trailing dot refused')
  else fail('G7b', 'trailing dot accepted')
  if (checkDeadTld('a@gmail.com').ok) pass('G7c', '.com itself unaffected — no substring matching')
  else fail('G7c', '🔴 .com is being refused; the match is not on the final label')
}

// ── G8 — every suggest-class typo maps to the right provider ─────────
{
  const cases: [string, string][] = [
    ['x@gmial.com','x@gmail.com'], ['x@gmal.com','x@gmail.com'], ['x@gamil.com','x@gmail.com'],
    ['x@gmali.com','x@gmail.com'], ['x@gnail.com','x@gmail.com'], ['x@gmaill.com','x@gmail.com'],
    ['x@hotmial.com','x@hotmail.com'], ['x@hotmai.com','x@hotmail.com'], ['x@hotmil.com','x@hotmail.com'],
    ['x@yahooo.com','x@yahoo.com'], ['x@yaho.com','x@yahoo.com'], ['x@yhoo.com','x@yahoo.com'],
    ['x@outlok.com','x@outlook.com'], ['x@outloo.com','x@outlook.com'],
    ['x@iclod.com','x@icloud.com'], ['x@icoud.com','x@icloud.com'],
  ]
  const wrong = cases.filter(([i,o]) => suggestEmailCorrection(i) !== o)
  if (wrong.length === 0) pass('G8', `all ${cases.length} provider typos suggest correctly`)
  else fail('G8', `wrong: ${wrong.map(([i,o]) => `${i} → ${suggestEmailCorrection(i)} (want ${o})`).join(' | ')}`)
}

console.log('')
console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
